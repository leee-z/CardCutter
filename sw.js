chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "download") return;
  if (!msg.dataUrl || !msg.filename) return;
  chrome.downloads.download({
    url: msg.dataUrl,
    filename: msg.filename,
    saveAs: true
  });
});

chrome.action.onClicked.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-ui" });
    return;
  } catch (_) {
    // fall through
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content/content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/lame.min.js", "content/content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-ui" });
  } catch (_) {
    // ignore
  }
});
