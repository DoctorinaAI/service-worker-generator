# Service Worker Example

This Flutter Web application demonstrates the usage of a generated **Service Worker** file created by the powerful command-line tool. The service worker is specifically designed for **Dart** and **Flutter Web** applications, providing efficient resource caching and offline capabilities.

## Overview

This example showcases how a generated service worker enhances Flutter Web apps by:
- Automatically cache application resources
- Provide offline functionality
- Enable progressive web app (PWA) capabilities
- Implement intelligent caching strategies for Dart/Flutter web apps

## Features Demonstrated

This example Flutter Web app showcases:

- **Automatic Resource Caching**: Uses a generated service worker that automatically caches application resources
- **Intelligent Loading**: Implements efficient loading strategies with progress tracking
- **Offline Support**: Demonstrates how the service worker enables offline functionality
- **Progressive Loading**: Shows smooth loading experience with detailed progress indicators
- **Cache Management**: Includes built-in cache reset and management capabilities

## Globally Available Functions

The example includes several globally available JavaScript functions in `index.html` for managing the loading experience:

### `resetAppCache()`
Clears all application caches and reloads the page. Useful for:
- Forcing fresh content updates
- Troubleshooting cache-related issues
- Providing users with a "reset" option when content appears stale

### `removeLoadingIndicator()`
Removes the loading screen and progress indicator from the page. Called when:
- The Flutter app has fully loaded
- The first frame is ready to be displayed
- All critical resources have been cached

### `updateLoadingProgress(progress, text)`
Updates the loading progress indicator with current status. Parameters:
- `progress` (number): Percentage completion (0-100)
- `text` (string): Descriptive text showing current loading step

These functions work together to provide a smooth, informative loading experience while the generated service worker caches resources and the Flutter app initializes.

## Getting Started

This project is a Flutter Web application that demonstrates service worker integration and advanced loading features.

### Running the Example

1. Ensure you have Flutter installed
2. Run `flutter pub get` to install dependencies
3. Use `flutter build web` to build the web application
4. Run `dart run sw:generate` to generate the service worker file
5. Serve the built files from the `build/web` directory

### Service Worker Features in Action

This example demonstrates:

- Progressive resource caching by the generated service worker
- Offline functionality when network is unavailable
- Real-time loading progress tracking
- Cache management and reset capabilities
- Stalled loading detection and recovery mechanisms

For more information about Flutter development:
- [Flutter Web Documentation](https://docs.flutter.dev/platform-integration/web)
- [Service Workers Guide](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [Progressive Web Apps](https://web.dev/progressive-web-apps/)
