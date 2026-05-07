chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "tourmaline-offscreen-download-markdown") return false;

  try {
    const blob = new Blob([String(message.markdown ?? "")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = message.filename || "Untitled.md";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
  return true;
});
