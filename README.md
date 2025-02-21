# RudderStack Data Viewer Chrome Extension

A Chrome extension for reading and displaying RudderStack-related data stored temporarily in **Local Storage**. It processes the stored JSON data (such as beautifying the JSON) and presents **RudderStack events** like `track` events in a **popup or side panel**.
This extension was initially developed with the help of **ChatGPT** and **Claude**. While it is functional, there is significant room for improvement in terms of performance, accuracy, and additional features.

## Features
- 📌 Reads RudderStack data from **Local Storage** in real-time
- 📌 Beautifies JSON data for better readability
- 📌 Displays `track` events inside a **popup** or **side panel**
- 📌 Helps debug and monitor RudderStack event flow in real time
- 📌 Maintains connection stability across page reloads
- 📌 Handles Next.js and modern framework environments
- 📌 Provides robust error handling and recovery

## Installation
1. Clone this repository:
   ```bash
   git clone https://github.com/mehrdadkhoddami/rudderstack-chrome-extension
   ```
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (top-right corner).
4. Click on **Load unpacked** and select the extension folder.

## Technical Details

### Architecture
- Uses a port-based communication system for reliable data transfer
- Implements safe localStorage access patterns
- Provides fallback mechanisms for connection failures
- Includes automatic reconnection on errors
- Features comprehensive error boundaries

### Performance Optimizations
- Implements debouncing for storage updates
- Uses efficient state comparison
- Minimizes unnecessary DOM operations
- Provides backup monitoring mechanisms

## Known Issues & Possible Improvements

### 1. Missing the 10th Event (Batch Completer)
- Since the extension reads from **Local Storage**, the **10th event**, which completes a batch, does not get stored in Local Storage and is therefore missing in the extension.
- A potential fix is to **catch outgoing batch requests** and extract the missing event from there. However, implementing this requires additional work beyond the current scope.

### 2. List Updates in Popup
- The event list updates only while the **popup is open**.
- A possible solution is to use a **Service Worker** and `background.js` to keep the event list updated even when the popup is closed.

### 3. Shared Data Across Multiple Tabs
- Since **Local Storage is shared across all tabs** of the same website, if multiple tabs are open, the displayed data may be mixed.
- The current implementation includes tab-specific data handling, but further improvements could be made for more precise tab isolation

### 4. Framework Compatibility
- While the extension now handles modern frameworks better, some edge cases might still exist
- Continuous testing with different framework versions is recommended

## Contributing
Pull requests are welcome! If you find issues or have feature suggestions, feel free to open an issue.

## License
This project is licensed under the [MIT License](LICENSE).

