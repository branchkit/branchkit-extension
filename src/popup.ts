// Popup script — shows connection status to BranchKit desktop app.

async function checkStatus(): Promise<void> {
  const dot = document.getElementById('dot')!;
  const text = document.getElementById('status-text')!;

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_HEALTH' });
    if (resp?.branchkit) {
      dot.className = 'dot connected';
      text.textContent = 'Connected to BranchKit';
    } else {
      dot.className = 'dot disconnected';
      text.textContent = 'BranchKit not detected';
    }
  } catch {
    dot.className = 'dot disconnected';
    text.textContent = 'Extension error';
  }
}

checkStatus();
