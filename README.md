# Service Worker Generator

[![Checkout](https://github.com/DoctorinaAI/service-worker-generator/actions/workflows/checkout.yml/badge.svg)](https://github.com/DoctorinaAI/service-worker-generator/actions/workflows/checkout.yml)
[![Pub Package](https://img.shields.io/pub/v/sw.svg)](https://pub.dev/packages/sw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Dart](https://img.shields.io/badge/Dart-%230175C2.svg?style=flat&logo=dart&logoColor=white)](https://dart.dev)
[![Flutter](https://img.shields.io/badge/Flutter-%2302569B.svg?style=flat&logo=Flutter&logoColor=white)](https://flutter.dev)

A powerful command-line tool for automatically generating **Service Worker** files for web applications. Specifically designed for **Dart** and **Flutter Web** applications, it simplifies the process of creating efficient service workers with intelligent resource caching.

## 🚀 Features

- ✅ **Automatic File Scanning** — Analyzes build directory and creates resource map with MD5 hashes
- ✅ **Smart Caching Strategy** — Implements cache-first with network fallback and runtime caching
- ✅ **Version Management** — Handles cache versioning for safe deployments and updates
- ✅ **Flexible File Filtering** — Include/exclude files using powerful glob patterns
- ✅ **Flutter Web Optimized** — Special support for Flutter web applications and assets
- ✅ **Cross-Platform** — Works seamlessly on Windows, macOS, and Linux
- ✅ **Customizable Cache Names** — Configure cache prefixes and versions
- ✅ **Integrity Validation** — MD5 hashing for file integrity verification
- ✅ **Offline Support** — Ensures your app works without internet connection
- ✅ **PWA Ready** — Perfect for Progressive Web Applications

## 📦 Installation

### Global Installation

```shell
dart pub global activate sw
```

## 🛠 Usage

### Basic Usage

```shell
dart run sw:generate --help
```

### Advanced Usage

```shell
# Custom input directory and output file
dart run sw:generate --input build/web --output flutter_service_worker.js

# Custom cache prefix and version
dart run sw:generate --prefix my-app --version 1.2.3

# Filter files with glob patterns
dart run sw:generate \
    --glob="**.{html,js,wasm,json}; assets/**; canvaskit/**; icons/**"
    --no-glob="flutter_service_worker.js; **/*.map; assets/NOTICES"

# Include comments in generated file
dart run sw:generate --comments
```

## 📋 Command Line Options

| Option       | Short | Description                                   | Default           |
| ------------ | ----- | --------------------------------------------- | ----------------- |
| `--help`     | `-h`  | Show help information                         | -                 |
| `--input`    | `-i`  | Path to build directory containing index.html | `build/web`       |
| `--output`   | `-o`  | Output service worker filename                | `sw.js`           |
| `--prefix`   | `-p`  | Cache name prefix                             | `app-cache`       |
| `--version`  | `-v`  | Cache version                                 | current timestamp |
| `--glob`     | `-g`  | Glob patterns to include files                | `**`              |
| `--no-glob`  | `-e`  | Glob patterns to exclude files                | -                 |
| `--comments` | `-c`  | Include comments in generated file            | `false`           |

## 📁 Usage Examples

```shell
# 1. Install dependencies
flutter pub get

# 2. Activate the service worker generator
dart pub global activate sw

# 3. (Optional) Run code generation
dart run build_runner build --delete-conflicting-outputs --release

# 4. Build Flutter project
flutter build web --release --no-tree-shake-icons --no-web-resources-cdn --base-href=/ -o build/web

# 5. Generate service worker
dart run sw:generate --input=build/web \
    --output=flutter_service_worker.js \
    --prefix=flutter-app \
    --glob="**.{html,js,wasm,json}; assets/**; canvaskit/**; icons/**" \
    --no-glob="flutter_service_worker.js; **/*.map; assets/NOTICES" \
    --comments
```

## 📖 Generated Service Worker Structure

The generated service worker includes:

- **🗄️ Resource Caching** — All specified files are cached during installation
- **⚡ Cache-First Strategy** — Prioritizes cache over network for better performance
- **🔄 Cache Versioning** — Automatic cache updates when version changes
- **🧹 Smart Cleanup** — Removes old cache versions automatically
- **📱 Runtime Caching** — Dynamic caching of new resources during runtime
- **🔍 Integrity Checks** — MD5 hash validation for cached resources
- **⏱️ TTL Support** — Time-based cache expiration
- **📊 Size Limits** — Configurable cache size limits

## 🤝 Contributing

We welcome contributions to this project! Please follow these steps:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Make** your changes and add tests
4. **Ensure** all tests pass (`dart test`)
5. **Commit** your changes (`git commit -m 'Add amazing feature'`)
6. **Push** to the branch (`git push origin feature/amazing-feature`)
7. **Create** a Pull Request

To use this package from local path, you can clone the repository and run:

```shell
dart pub global activate --source path .
```

## 📝 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
