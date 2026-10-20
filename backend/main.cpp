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

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
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
                            {"version", "1.0.0"}}
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
