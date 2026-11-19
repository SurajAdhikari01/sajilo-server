#if __has_include(<httplib.h>)
#include <httplib.h>
#else
#include "httplib.h"
#endif

#if __has_include(<nlohmann/json.hpp>)
#include <nlohmann/json.hpp>
#elif __has_include(<json.hpp>)
#include <json.hpp>
#else
#include "json.hpp"
#endif

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <fcntl.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <poll.h>
#include <signal.h>
#include <sstream>
#include <string>
#include <sys/stat.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

using json = nlohmann::json;

struct RunResult
{
    std::string output;
    int exit_code = -1;
    bool timed_out = false;
    std::string error_detail;
};

struct TempFiles
{
    std::string in, out;
    ~TempFiles()
    {
        if (!in.empty())
            unlink(in.c_str());
        if (!out.empty())
            unlink(out.c_str());
    }
};

static std::string resolve_sajilo_binary()
{
    // 1. Check SAJILO_PATH environment variable
    if (const char *env_path = std::getenv("SAJILO_PATH"))
    {
        if (access(env_path, X_OK) == 0)
        {
            return std::string(env_path);
        }
    }

    // 2. Check standard installation and local development paths
    const std::vector<std::string> search_paths = {
        "/usr/local/bin/sajilo",
        "/opt/homebrew/bin/sajilo",
        "./sajilo",
        "../sajilo",
        "../../sajilo",
        "../build/sajilo",
        "../../build/sajilo"};

    for (const auto &p : search_paths)
    {
        if (access(p.c_str(), X_OK) == 0)
        {
            return p;
        }
    }

    return "";
}

static std::string generate_mock_ir(const std::string &code)
{
    std::ostringstream ss;
    ss << "; ====================================================================\n";
    ss << "; Sajilo Compiler IR (Simulation / Standby Mode)\n";
    ss << "; (Set SAJILO_PATH to connect your custom compiler binary)\n";
    ss << "; ====================================================================\n\n";

    ss << "; Source snippet (" << code.length() << " chars):\n";
    std::istringstream stream(code);
    std::string line;
    int line_num = 1;
    while (std::getline(stream, line) && line_num <= 10)
    {
        ss << "; " << line_num++ << " | " << line << "\n";
    }
    if (line_num > 10)
    {
        ss << "; ... (truncated)\n";
    }

    ss << "\nmain:\n";
    ss << "  test = 10\n";
    ss << "  a = 1\n";
    ss << "  b = 2\n";
    ss << "  t0 = a + b\n";
    ss << "  if false t0 jmp b1\n";
    ss << "b0:\n";
    ss << "  t1 = a + b\n";
    ss << "  param test\n";
    ss << "  return\n";
    ss << "  jmp b2\n";
    ss << "b1:\n";
    ss << "  param 0\n";
    ss << "  call sys_exit\n";
    ss << "  jmp b2\n";
    ss << "b2:\n";
    ss << "  return 0\n";
    return ss.str();
}

RunResult compile_code(const std::string &code)
{
    RunResult result;

    // Check if simulation mode is explicitly enabled
    const char *mock_env = std::getenv("SAJILO_MOCK");
    bool force_mock = (mock_env && std::string(mock_env) == "1");

    std::string sajilo_path = resolve_sajilo_binary();
    if (sajilo_path.empty() && !force_mock)
    {
        // Check if sajilo is runnable via PATH
        if (system("which sajilo > /dev/null 2>&1") != 0)
        {
            result.exit_code = 127;
            result.error_detail = "Compiler binary 'sajilo' not found in PATH or standard paths (/usr/local/bin/sajilo, /opt/homebrew/bin/sajilo).\n"
                                  "Please set the SAJILO_PATH environment variable to your compiler binary.";
            return result;
        }
        sajilo_path = "sajilo";
    }
    else if (force_mock)
    {
        result.exit_code = 0;
        result.output = generate_mock_ir(code);
        return result;
    }

    // Sajilo requires input files to end with .sj
    char in_tpl[] = "/tmp/sajilo_in_XXXXXX.sj";
    char out_tpl[] = "/tmp/sajilo_out_XXXXXX.json";
    int in_fd = mkstemps(in_tpl, 3);
    int out_fd = mkstemps(out_tpl, 5);
    if (in_fd < 0 || out_fd < 0)
    {
        if (in_fd >= 0)
        {
            close(in_fd);
            unlink(in_tpl);
        }
        if (out_fd >= 0)
        {
            close(out_fd);
            unlink(out_tpl);
        }
        result.exit_code = 1;
        result.error_detail = "Failed to create temporary compilation files";
        return result;
    }
    close(in_fd);
    close(out_fd);

    TempFiles tmp{in_tpl, out_tpl};
    const std::string &input_file = tmp.in;
    const std::string &output_file = tmp.out;

    {
        std::ofstream in_file(input_file);
        if (!in_file.is_open())
        {
            result.exit_code = 1;
            result.error_detail = "Failed to write input source to temporary file";
            return result;
        }
        in_file << code;
    }

    // Command: sajilo <input.sj> -o json <output.json>
    std::vector<const char *> args = {sajilo_path.c_str(), input_file.c_str(), "-o", "json", output_file.c_str(), nullptr};

    pid_t pid = fork();
    if (pid < 0)
    {
        result.exit_code = 1;
        result.error_detail = "Failed to fork compiler process";
        return result;
    }
    if (pid == 0)
    {
        if (sajilo_path == "sajilo")
        {
            execvp("sajilo", (char *const *)args.data());
        }
        else
        {
            execv(sajilo_path.c_str(), (char *const *)args.data());
        }
        _exit(127);
    }

    int status = 0;
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (true)
    {
        pid_t w = waitpid(pid, &status, WNOHANG);
        if (w == pid)
            break;
        if (w < 0)
        {
            result.exit_code = 1;
            result.error_detail = "waitpid error while compiling";
            return result;
        }
        if (std::chrono::steady_clock::now() > deadline)
        {
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            result.timed_out = true;
            return result;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    result.exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 1;

    std::ifstream out_file(output_file);
    if (out_file.is_open())
    {
        std::stringstream ss;
        ss << out_file.rdbuf();
        result.output = ss.str();
    }
    return result;
}

// ============================================================================
// x86-64 EXECUTION (NASM -> ld -> run)
// ============================================================================
//
// The Sajilo compiler emits NASM x86-64 assembly that targets Linux syscalls
// (_start entry, `syscall` with rax=60/0/1). That binary can only run on an
// x86-64 Linux kernel, so we pick a runner:
//   - native: host is x86-64 Linux with nasm + ld installed
//   - docker: everything else (e.g. Apple Silicon macOS) -> linux/amd64 container
// Override with SAJILO_RUNNER=native|docker.

static constexpr int RUN_PROGRAM_TIMEOUT_SEC = 5;   // program wall-clock limit
static constexpr size_t RUN_MAX_OUTPUT = 1 << 20;   // 1 MiB per stream returned

// Shell script executed inside the work dir (natively or in the container).
// Writes each stage's result into files so the server can report precisely
// which step failed. `ulimit -f` caps what the program may write (~2 MiB).
static std::string run_script()
{
    return std::string(
               "nasm -f elf64 -o prog.o prog.asm > asm.log 2>&1 || { echo assemble > stage; exit 0; }\n"
               "ld -o prog prog.o > ld.log 2>&1 || { echo link > stage; exit 0; }\n"
               "echo run > stage\n"
               "ulimit -f 4096\n"
               "timeout -k 1 ") +
           std::to_string(RUN_PROGRAM_TIMEOUT_SEC) +
           " ./prog < stdin.txt > stdout.txt 2> stderr.txt\n"
           "echo $? > exit_code\n";
}

static const char *RUNNER_DOCKERFILE =
    "FROM debian:bookworm-slim\n"
    "RUN apt-get update && apt-get install -y --no-install-recommends nasm binutils coreutils \\\n"
    "    && rm -rf /var/lib/apt/lists/*\n"
    "WORKDIR /work\n";

struct ProcResult
{
    int exit_code = -1;
    bool timed_out = false;
    std::string output; // combined stdout + stderr
};

// fork/exec with optional cwd + stdin, combined output capture and a hard timeout.
static ProcResult run_process(const std::vector<std::string> &argv, int timeout_sec,
                              const std::string &cwd = "", const std::string *stdin_data = nullptr)
{
    ProcResult r;
    int out_pipe[2];
    int in_pipe[2] = {-1, -1};
    if (pipe(out_pipe) != 0)
    {
        r.output = "pipe() failed";
        return r;
    }
    if (stdin_data && pipe(in_pipe) != 0)
    {
        close(out_pipe[0]);
        close(out_pipe[1]);
        r.output = "pipe() failed";
        return r;
    }

    std::vector<char *> cargv;
    for (const auto &a : argv)
        cargv.push_back(const_cast<char *>(a.c_str()));
    cargv.push_back(nullptr);

    pid_t pid = fork();
    if (pid < 0)
    {
        close(out_pipe[0]);
        close(out_pipe[1]);
        if (stdin_data)
        {
            close(in_pipe[0]);
            close(in_pipe[1]);
        }
        r.output = "fork() failed";
        return r;
    }

    if (pid == 0)
    {
        setpgid(0, 0); // own process group so a timeout kills all descendants
        if (!cwd.empty() && chdir(cwd.c_str()) != 0)
            _exit(126);
        dup2(out_pipe[1], STDOUT_FILENO);
        dup2(out_pipe[1], STDERR_FILENO);
        if (stdin_data)
        {
            dup2(in_pipe[0], STDIN_FILENO);
            close(in_pipe[0]);
            close(in_pipe[1]);
        }
        else
        {
            int devnull = open("/dev/null", O_RDONLY);
            if (devnull >= 0)
            {
                dup2(devnull, STDIN_FILENO);
                close(devnull);
            }
        }
        close(out_pipe[0]);
        close(out_pipe[1]);
        execvp(cargv[0], cargv.data());
        _exit(127);
    }

    close(out_pipe[1]);
    if (stdin_data)
    {
        close(in_pipe[0]);
        const char *p = stdin_data->data();
        size_t left = stdin_data->size();
        while (left > 0)
        {
            ssize_t n = write(in_pipe[1], p, left);
            if (n <= 0)
                break;
            p += n;
            left -= static_cast<size_t>(n);
        }
        close(in_pipe[1]);
    }

    fcntl(out_pipe[0], F_SETFL, fcntl(out_pipe[0], F_GETFL) | O_NONBLOCK);
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(timeout_sec);
    bool exited = false, eof = false;
    int status = 0;
    char buf[8192];

    while (!(exited && eof))
    {
        struct pollfd pfd = {out_pipe[0], POLLIN, 0};
        if (!eof && poll(&pfd, 1, 50) > 0)
        {
            ssize_t n;
            while ((n = read(out_pipe[0], buf, sizeof(buf))) > 0)
            {
                if (r.output.size() < RUN_MAX_OUTPUT)
                    r.output.append(buf, static_cast<size_t>(n));
            }
            if (n == 0)
                eof = true;
        }
        else if (eof)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }

        if (!exited)
        {
            pid_t w = waitpid(pid, &status, WNOHANG);
            if (w == pid)
            {
                exited = true;
                // Grandchildren may still hold the pipe; give them a short grace period.
                if (!eof)
                    deadline = std::min(deadline, std::chrono::steady_clock::now() + std::chrono::milliseconds(500));
            }
        }

        if (std::chrono::steady_clock::now() > deadline)
        {
            if (!exited)
            {
                kill(-pid, SIGKILL);
                waitpid(pid, &status, 0);
                r.timed_out = true;
                exited = true;
            }
            break;
        }
    }
    close(out_pipe[0]);

    if (!r.timed_out)
        r.exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    return r;
}

static std::string read_file_capped(const std::string &path, size_t max_bytes = RUN_MAX_OUTPUT)
{
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open())
        return "";
    std::string data(max_bytes, '\0');
    f.read(&data[0], static_cast<std::streamsize>(max_bytes));
    data.resize(static_cast<size_t>(f.gcount()));
    if (f.peek() != EOF)
        data += "\n... [output truncated at " + std::to_string(max_bytes) + " bytes]\n";
    return data;
}

static std::string trim(std::string s)
{
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' '))
        s.pop_back();
    size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\n'))
        ++i;
    return s.substr(i);
}

static bool host_is_x86_64_linux()
{
#if defined(__linux__) && (defined(__x86_64__) || defined(_M_X64))
    return true;
#else
    return false;
#endif
}

static std::string runner_mode()
{
    if (const char *env = std::getenv("SAJILO_RUNNER"))
    {
        std::string m = env;
        if (m == "native" || m == "docker")
            return m;
    }
    return host_is_x86_64_linux() ? "native" : "docker";
}

static std::string resolve_docker_binary()
{
    if (const char *env = std::getenv("DOCKER_PATH"))
        if (access(env, X_OK) == 0)
            return env;
    for (const char *p : {"/usr/local/bin/docker", "/opt/homebrew/bin/docker",
                          "/Applications/Docker.app/Contents/Resources/bin/docker", "/usr/bin/docker"})
        if (access(p, X_OK) == 0)
            return p;
    return "docker"; // fall back to $PATH lookup via execvp
}

static std::string runner_image()
{
    const char *env = std::getenv("SAJILO_RUNNER_IMAGE");
    return env && *env ? env : "sajilo-x86-runner:latest";
}

// Makes sure the Docker daemon is reachable and the runner image exists
// (building it on first use). Returns an empty string on success, else an error.
static std::string ensure_docker_runner()
{
    static std::mutex mtx;
    static bool image_ready = false;
    std::lock_guard<std::mutex> lock(mtx);

    const std::string docker = resolve_docker_binary();
    ProcResult ver = run_process({docker, "version", "--format", "{{.Server.Version}}"}, 15);
    if (ver.exit_code == 127)
        return "Docker CLI not found. Install Docker Desktop (or set DOCKER_PATH) to run x86-64 code on this machine.";
    if (ver.exit_code != 0)
        return "Docker daemon is not running. Start Docker Desktop and try again.\n\n" + trim(ver.output);

    if (image_ready)
        return "";

    const std::string image = runner_image();
    if (run_process({docker, "image", "inspect", image}, 15).exit_code == 0)
    {
        image_ready = true;
        return "";
    }

    std::cout << "[Sajilo Runner] Building Docker image " << image << " (one-time setup)...\n";
    std::string dockerfile = RUNNER_DOCKERFILE;
    ProcResult build = run_process({docker, "build", "--platform", "linux/amd64", "-t", image, "-"}, 600, "", &dockerfile);
    if (build.timed_out)
        return "Timed out while building the x86-64 runner Docker image.";
    if (build.exit_code != 0)
        return "Failed to build the x86-64 runner Docker image:\n\n" + trim(build.output);

    std::cout << "[Sajilo Runner] Image " << image << " ready.\n";
    image_ready = true;
    return "";
}

static const char *linux_signal_name(int sig)
{
    switch (sig)
    {
    case 4: return "SIGILL (illegal instruction)";
    case 5: return "SIGTRAP (trace/breakpoint trap)";
    case 6: return "SIGABRT (aborted)";
    case 7: return "SIGBUS (bus error)";
    case 8: return "SIGFPE (arithmetic exception)";
    case 9: return "SIGKILL (killed)";
    case 11: return "SIGSEGV (segmentation fault)";
    case 13: return "SIGPIPE (broken pipe)";
    case 15: return "SIGTERM (terminated)";
    case 25: return "SIGXFSZ (output size limit exceeded)";
    default: return "";
    }
}

static json run_x86_assembly(const std::string &asm_code, const std::string &stdin_data)
{
    const std::string mode = runner_mode();
    json resp = {{"status", false}, {"runner", mode}, {"stage", "setup"},
                 {"stdout", ""}, {"stderr", ""}, {"exit_code", nullptr},
                 {"signal", nullptr}, {"timed_out", false}, {"error", ""}};

    // Per-request scratch directory
    char dir_tpl[] = "/tmp/sajilo_run_XXXXXX";
    if (!mkdtemp(dir_tpl))
    {
        resp["error"] = "Failed to create temporary run directory";
        return resp;
    }
    std::error_code ec;
    std::string work_dir = std::filesystem::canonical(dir_tpl, ec).string();
    if (ec)
        work_dir = dir_tpl;
    struct DirCleanup
    {
        std::string path;
        ~DirCleanup()
        {
            std::error_code e;
            std::filesystem::remove_all(path, e);
        }
    } cleanup{work_dir};
    chmod(work_dir.c_str(), 0777); // container user must be able to write here

    {
        std::ofstream(work_dir + "/prog.asm") << asm_code;
        std::ofstream(work_dir + "/stdin.txt") << stdin_data;
    }

    const auto start = std::chrono::steady_clock::now();
    ProcResult proc;
    const std::string script = run_script();

    if (mode == "docker")
    {
        std::string err = ensure_docker_runner();
        if (!err.empty())
        {
            resp["error"] = err;
            return resp;
        }
        static std::atomic<unsigned> counter{0};
        const std::string name = "sajilo-run-" + std::to_string(getpid()) + "-" + std::to_string(counter++);
        const std::string docker = resolve_docker_binary();
        proc = run_process({docker, "run", "--rm", "--name", name,
                            "--platform", "linux/amd64",
                            "--network", "none",
                            "--memory", "256m", "--pids-limit", "64", "--cpus", "1",
                            "-v", work_dir + ":/work", "-w", "/work",
                            runner_image(), "sh", "-c", script},
                           RUN_PROGRAM_TIMEOUT_SEC + 30);
        if (proc.timed_out)
            run_process({docker, "rm", "-f", name}, 15);
    }
    else
    {
        proc = run_process({"/bin/sh", "-c", script}, RUN_PROGRAM_TIMEOUT_SEC + 15, work_dir);
    }

    resp["duration_ms"] = std::chrono::duration_cast<std::chrono::milliseconds>(
                              std::chrono::steady_clock::now() - start)
                              .count();

    const std::string stage = trim(read_file_capped(work_dir + "/stage", 64));
    resp["assembler_output"] = trim(read_file_capped(work_dir + "/asm.log"));
    resp["linker_output"] = trim(read_file_capped(work_dir + "/ld.log"));

    if (stage.empty())
    {
        // The runner itself failed before reaching any stage
        resp["error"] = proc.timed_out ? "Runner timed out before the program started."
                                       : "Runner failed (exit " + std::to_string(proc.exit_code) + "):\n\n" + trim(proc.output);
        if (mode == "native")
            resp["error"] = resp["error"].get<std::string>() + "\n\nNative mode requires `nasm`, `ld` and `timeout` in PATH.";
        return resp;
    }

    resp["stage"] = stage;
    if (stage == "assemble")
    {
        resp["error"] = "Assembly failed (nasm):\n\n" + resp["assembler_output"].get<std::string>();
        return resp;
    }
    if (stage == "link")
    {
        resp["error"] = "Linking failed (ld):\n\n" + resp["linker_output"].get<std::string>();
        return resp;
    }

    resp["stdout"] = read_file_capped(work_dir + "/stdout.txt");
    resp["stderr"] = read_file_capped(work_dir + "/stderr.txt");

    std::string code_str = trim(read_file_capped(work_dir + "/exit_code", 32));
    int exit_code = -1;
    try
    {
        exit_code = std::stoi(code_str);
    }
    catch (...)
    {
        resp["error"] = proc.timed_out ? "Program timed out." : "Could not determine program exit code.";
        resp["timed_out"] = proc.timed_out;
        return resp;
    }

    resp["status"] = true;
    resp["exit_code"] = exit_code;
    if (exit_code == 124 || exit_code == 137)
    {
        resp["timed_out"] = true;
        resp["error"] = "Program exceeded the " + std::to_string(RUN_PROGRAM_TIMEOUT_SEC) + "s time limit and was killed.";
    }
    else if (exit_code > 128)
    {
        int sig = exit_code - 128;
        std::string sname = linux_signal_name(sig);
        resp["signal"] = sig;
        resp["error"] = "Program terminated by signal " + std::to_string(sig) + (sname.empty() ? "" : " " + sname);
    }
    return resp;
}

static void send_cors_headers(httplib::Response &res)
{
    if (!res.has_header("Access-Control-Allow-Origin"))
    {
        res.set_header("Access-Control-Allow-Origin", "*");
    }
    if (!res.has_header("Access-Control-Allow-Methods"))
    {
        res.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (!res.has_header("Access-Control-Allow-Headers"))
    {
        res.set_header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-Requested-With");
    }
}

static void send_error(httplib::Response &res, int status, const std::string &msg)
{
    send_cors_headers(res);
    res.status = status;
    res.set_content(json{{"status", false}, {"error", msg}, {"output", msg}, {"ir", msg}}.dump(), "application/json");
}

static std::string find_frontend_path(int argc, char *argv[])
{
    if (argc > 2)
    {
        return argv[2];
    }
    if (const char *env_fe = std::getenv("FRONTEND_DIR"))
    {
        return env_fe;
    }

    const std::vector<std::string> candidates = {
        "./frontend",
        "../frontend",
        "../../frontend",
        "frontend"};

    for (const auto &c : candidates)
    {
        struct stat st;
        std::string test_file = c + "/index.html";
        if (stat(test_file.c_str(), &st) == 0)
        {
            return c;
        }
    }
    return "";
}

int main(int argc, char *argv[])
{
    int port = 8080;
    if (argc > 1)
    {
        try
        {
            port = std::stoi(argv[1]);
        }
        catch (...)
        {
            std::cerr << "Invalid port argument, defaulting to 8080\n";
        }
    }
    else if (const char *env_port = std::getenv("PORT"))
    {
        try
        {
            port = std::stoi(env_port);
        }
        catch (...)
        {
            std::cerr << "Invalid PORT environment variable, defaulting to 8080\n";
        }
    }

    signal(SIGPIPE, SIG_IGN); // never die writing to a closed child stdin

    httplib::Server server;
    server.set_payload_max_length(1024 * 1024 * 10);

    // Global CORS Pre-Routing Handler
    server.set_pre_routing_handler([](const httplib::Request &req, httplib::Response &res) {
        send_cors_headers(res);
        if (req.method == "OPTIONS")
        {
            res.status = 204;
            return httplib::Server::HandlerResponse::Handled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });

    // Never let the browser serve stale frontend files (app.js / style.css)
    server.set_post_routing_handler([](const httplib::Request &, httplib::Response &res) {
        if (!res.has_header("Cache-Control"))
            res.set_header("Cache-Control", "no-cache, no-store, must-revalidate");
    });

    // Mount frontend directory if found
    std::string frontend_dir = find_frontend_path(argc, argv);
    if (!frontend_dir.empty())
    {
        if (server.set_mount_point("/", frontend_dir))
        {
            std::cout << "[Sajilo Server] Frontend mounted from: " << frontend_dir << "\n";
        }
        else
        {
            std::cerr << "[Sajilo Server] Warning: Failed to mount frontend from " << frontend_dir << "\n";
        }
    }
    else
    {
        std::cout << "[Sajilo Server] No frontend directory found; running in standalone API mode.\n";
    }

    // Health check endpoint
    server.Get("/health", [](const httplib::Request &, httplib::Response &res) {
        send_cors_headers(res);
        res.status = 200;
        res.set_content(json{
                            {"status", "ok"},
                            {"service", "sajilo-server"},
                            {"version", "1.0.0"},
                            {"runner", runner_mode()}}
                            .dump(),
                        "application/json");
    });

    // OPTIONS preflight handler for /compile
    server.Options("/compile", [](const httplib::Request &, httplib::Response &res) {
        send_cors_headers(res);
        res.status = 204;
    });

    // POST /compile handler
    server.Post("/compile", [](const httplib::Request &req, httplib::Response &res) {
        send_cors_headers(res);

        std::string code;
        if (req.has_header("Content-Type") && req.get_header_value("Content-Type").find("application/json") != std::string::npos)
        {
            json body = json::parse(req.body, nullptr, false);
            if (body.is_discarded() || !body.is_object())
            {
                send_error(res, 400, "Request JSON must be a valid object");
                return;
            }

            // Handle multi-file compilation payload if provided
            if (body.contains("files") && body["files"].is_array() && !body["files"].empty())
            {
                std::string main_part;
                std::string other_part;
                for (const auto &item : body["files"])
                {
                    if (item.is_object() && item.contains("content") && item["content"].is_string())
                    {
                        std::string fname = item.contains("name") && item["name"].is_string() ? item["name"].get<std::string>() : "";
                        std::string content = item["content"].get<std::string>();
                        if (fname == "main.sj" || content.find("func main") != std::string::npos)
                        {
                            main_part += (main_part.empty() ? "" : "\n\n") + content;
                        }
                        else
                        {
                            other_part += (other_part.empty() ? "" : "\n\n") + content;
                        }
                    }
                }
                if (!other_part.empty() && !main_part.empty())
                {
                    code = other_part + "\n\n" + main_part;
                }
                else if (!main_part.empty())
                {
                    code = main_part;
                }
                else
                {
                    code = other_part;
                }
            }

            if (code.empty() && body.contains("code") && body["code"].is_string())
            {
                code = body["code"].get<std::string>();
            }
        }
        else
        {
            // Try parsing JSON first; if not JSON, treat body as raw source code
            json body = json::parse(req.body, nullptr, false);
            if (!body.is_discarded() && body.is_object())
            {
                if (body.contains("files") && body["files"].is_array() && !body["files"].empty())
                {
                    std::string main_part;
                    std::string other_part;
                    for (const auto &item : body["files"])
                    {
                        if (item.is_object() && item.contains("content") && item["content"].is_string())
                        {
                            std::string fname = item.contains("name") && item["name"].is_string() ? item["name"].get<std::string>() : "";
                            std::string content = item["content"].get<std::string>();
                            if (fname == "main.sj" || content.find("func main") != std::string::npos)
                            {
                                main_part += (main_part.empty() ? "" : "\n\n") + content;
                            }
                            else
                            {
                                other_part += (other_part.empty() ? "" : "\n\n") + content;
                            }
                        }
                    }
                    if (!other_part.empty() && !main_part.empty())
                    {
                        code = other_part + "\n\n" + main_part;
                    }
                    else if (!main_part.empty())
                    {
                        code = main_part;
                    }
                    else
                    {
                        code = other_part;
                    }
                }
                if (code.empty() && body.contains("code") && body["code"].is_string())
                {
                    code = body["code"].get<std::string>();
                }
            }
            else
            {
                code = req.body;
            }
        }

        if (code.empty())
        {
            send_error(res, 400, "Input source code cannot be empty");
            return;
        }

        std::cout << "[Sajilo Server] Compiling " << code.length() << " chars of Sajilo code...\n";

        RunResult result = compile_code(code);

        if (result.timed_out)
        {
            send_error(res, 504, "Compilation timed out after 5 seconds");
            return;
        }

        if (result.exit_code == 127)
        {
            std::string msg = result.error_detail.empty() ? "Compiler binary 'sajilo' not found" : result.error_detail;
            send_error(res, 500, msg);
            return;
        }

        json data = json::parse(result.output, nullptr, false);

        if (!data.is_discarded())
        {
            // sajilo compiler produced standard JSON (status, output, error)
            res.status = 200;
            res.set_content(data.dump(), "application/json");
            return;
        }

        if (result.exit_code == 0)
        {
            // Compiler returned raw text IR/assembly output
            json resp = {
                {"status", true},
                {"output", result.output},
                {"error", ""}};
            res.status = 200;
            res.set_content(resp.dump(), "application/json");
            return;
        }

        // Non-zero exit with raw text error
        std::string err_msg = result.output.empty() ? (result.error_detail.empty() ? "compilation failed" : result.error_detail) : result.output;
        res.status = 200;
        res.set_content(json{
                            {"status", false},
                            {"error", err_msg},
                            {"output", ""}}
                            .dump(),
                        "application/json");
    });

    // POST /run: assemble (nasm), link (ld) and execute generated x86-64 code.
    // Body: { "asm": "<nasm source>", "stdin": "<optional program input>" }
    server.Post("/run", [](const httplib::Request &req, httplib::Response &res) {
        send_cors_headers(res);
        json body = json::parse(req.body, nullptr, false);
        if (body.is_discarded() || !body.is_object())
        {
            send_error(res, 400, "Request body must be a JSON object: { \"asm\": \"...\", \"stdin\": \"...\" }");
            return;
        }

        std::string asm_code;
        for (const char *key : {"asm", "code", "output"})
        {
            if (body.contains(key) && body[key].is_string())
            {
                asm_code = body[key].get<std::string>();
                break;
            }
        }
        if (asm_code.find_first_not_of(" \t\r\n") == std::string::npos)
        {
            send_error(res, 400, "No assembly code provided. Compile your Sajilo code first.");
            return;
        }
        std::string stdin_data = body.contains("stdin") && body["stdin"].is_string() ? body["stdin"].get<std::string>() : "";

        std::cout << "[Sajilo Runner] Running " << asm_code.size() << " bytes of x86-64 asm (" << runner_mode() << ")...\n";
        json result = run_x86_assembly(asm_code, stdin_data);
        std::cout << "[Sajilo Runner] stage=" << result["stage"].get<std::string>()
                  << " exit=" << result["exit_code"].dump() << "\n";

        res.status = 200;
        res.set_content(result.dump(), "application/json");
    });

    // OPTIONS preflight handler for /api/save-file
    server.Options("/api/save-file", [](const httplib::Request &, httplib::Response &res) {
        send_cors_headers(res);
        res.status = 204;
    });

    // POST /api/save-file: Saves file directly to local laptop SSD via backend
    server.Post("/api/save-file", [](const httplib::Request &req, httplib::Response &res) {
        send_cors_headers(res);
        json body = json::parse(req.body, nullptr, false);
        if (body.is_discarded() || !body.is_object())
        {
            send_error(res, 400, "Request body must be a valid JSON object");
            return;
        }

        std::string target_path;
        if (body.contains("path") && body["path"].is_string() && !body["path"].get<std::string>().empty())
        {
            target_path = body["path"].get<std::string>();
        }
        else if (body.contains("filename") && body["filename"].is_string() && !body["filename"].get<std::string>().empty())
        {
            target_path = body["filename"].get<std::string>();
        }
        else
        {
            send_error(res, 400, "Missing 'path' or 'filename' parameter");
            return;
        }

        std::string content;
        if (body.contains("content") && body["content"].is_string())
        {
            content = body["content"].get<std::string>();
        }

        std::ofstream out(target_path, std::ios::out | std::ios::trunc);
        if (!out.is_open())
        {
            send_error(res, 500, "Failed to write file to local disk: " + target_path);
            return;
        }

        out << content;
        out.close();

        std::cout << "[Sajilo Server] Saved file to local SSD: " << target_path << " (" << content.size() << " bytes)\n";

        res.status = 200;
        res.set_content(json{
                            {"status", true},
                            {"path", target_path},
                            {"bytes", content.size()}}
                            .dump(),
                        "application/json");
    });

    std::cout << "========================================================\n";
    std::cout << " Sajilo C++ Server listening on http://localhost:" << port << "\n";
    if (!frontend_dir.empty())
    {
        std::cout << " Frontend available at: http://localhost:" << port << "/\n";
    }
    std::cout << " Compiler endpoint:     http://localhost:" << port << "/compile\n";
    std::cout << " Health endpoint:       http://localhost:" << port << "/health\n";
    std::cout << "========================================================\n";

    if (!server.listen("0.0.0.0", port))
    {
        std::cerr << "Failed to bind to 0.0.0.0:" << port << "!\n";
        return 1;
    }

    return 0;
}
