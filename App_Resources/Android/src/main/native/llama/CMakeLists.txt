cmake_minimum_required(VERSION 3.22)
project(faceclaw_llama CXX C)

# llama.cpp source tree location is injected by the gradle task (it downloads
# and extracts a pinned release tag before configuring this project).
if(NOT DEFINED LLAMA_CPP_SOURCE_DIR)
  message(FATAL_ERROR "Pass -DLLAMA_CPP_SOURCE_DIR=<path to llama.cpp checkout>")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Static llama/ggml folded into our single JNI .so. CPU only: Vulkan on Mali
# and mixed Adreno drivers is not worth the instability for short assistant
# turns. The -march baseline lives in the gradle invocation (armv8.2-a with
# dotprod+fp16: the floor for Tensor G2's X1/A78/A55, so no i8mm).
set(BUILD_SHARED_LIBS OFF)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL OFF CACHE BOOL "" FORCE)

add_subdirectory(${LLAMA_CPP_SOURCE_DIR} llama.cpp-build EXCLUDE_FROM_ALL)

add_library(faceclaw_llama SHARED faceclaw_llama.cpp)
target_link_libraries(faceclaw_llama PRIVATE llama android log)
