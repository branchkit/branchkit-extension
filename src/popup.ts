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

function initHintModeSelect(): void {
  const select = document.getElementById('hint-mode') as HTMLSelectElement;

  chrome.storage.sync.get('badgeDisplayMode', (result) => {
    if (result.badgeDisplayMode) {
      select.value = result.badgeDisplayMode;
    }
  });

  select.addEventListener('change', () => {
    chrome.storage.sync.set({ badgeDisplayMode: select.value });
  });
}

function initPlacementSelect(): void {
  const select = document.getElementById('placement') as HTMLSelectElement;

  chrome.storage.sync.get('placementStrategy', (result) => {
    if (result.placementStrategy) {
      select.value = result.placementStrategy;
    }
  });

  select.addEventListener('change', () => {
    chrome.storage.sync.set({ placementStrategy: select.value });
  });
}

checkStatus();
initHintModeSelect();
initPlacementSelect();
