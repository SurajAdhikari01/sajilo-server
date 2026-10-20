cmake_minimum_required(VERSION 3.16)
project(sajilo_server LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Find system threads
find_package(Threads REQUIRED)

# Find cpp-httplib (Homebrew or system)
find_package(httplib CONFIG QUIET)
if(NOT TARGET httplib::httplib)
    find_path(HTTPLIB_INCLUDE_DIR httplib.h
        HINTS
        /opt/homebrew/include
        /usr/local/include
        /opt/homebrew/opt/cpp-httplib/include
    )
endif()

# Find nlohmann_json (Homebrew or system)
find_package(nlohmann_json CONFIG QUIET)
if(NOT TARGET nlohmann_json::nlohmann_json)
    find_path(NLOHMANN_JSON_INCLUDE_DIR nlohmann/json.hpp
        HINTS
        /opt/homebrew/include
        /usr/local/include
        /opt/homebrew/opt/nlohmann-json/include
    )
endif()

add_executable(sajilo_server main.cpp)

# Link cpp-httplib
if(TARGET httplib::httplib)
    target_link_libraries(sajilo_server PRIVATE httplib::httplib)
elseif(HTTPLIB_INCLUDE_DIR)
    target_include_directories(sajilo_server PRIVATE ${HTTPLIB_INCLUDE_DIR})
else()
    message(FATAL_ERROR "cpp-httplib was not found. Please install it with: brew install cpp-httplib")
endif()

# Link nlohmann_json
if(TARGET nlohmann_json::nlohmann_json)
    target_link_libraries(sajilo_server PRIVATE nlohmann_json::nlohmann_json)
    get_target_property(NLOHMANN_INC nlohmann_json::nlohmann_json INTERFACE_INCLUDE_DIRECTORIES)
    if(NLOHMANN_INC)
        target_include_directories(sajilo_server PRIVATE "${NLOHMANN_INC}/nlohmann")
    endif()
elseif(NLOHMANN_JSON_INCLUDE_DIR)
    target_include_directories(sajilo_server PRIVATE
        ${NLOHMANN_JSON_INCLUDE_DIR}
        ${NLOHMANN_JSON_INCLUDE_DIR}/nlohmann
    )
else()
    message(FATAL_ERROR "nlohmann_json was not found. Please install it with: brew install nlohmann-json")
endif()

target_link_libraries(sajilo_server PRIVATE Threads::Threads)

# Compiler warnings
if(MSVC)
    target_compile_options(sajilo_server PRIVATE /W4)
else()
    target_compile_options(sajilo_server PRIVATE -Wall -Wextra)
endif()

