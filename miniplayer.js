// Double-Click Value Reset & Toggle Helper
function setupValueToggle(valEl, sliderEl, neutralVal, formatFn) {
  let prevVal = parseFloat(sliderEl.value);
  valEl.title = 'Double-click to reset to neutral / restore previous';

  valEl.ondblclick = (e) => {
    e.preventDefault();
    const cur = parseFloat(sliderEl.value);
    if (Math.abs(cur - neutralVal) < 0.001) {
      // Currently at neutral, restore previous
      const target = (prevVal !== undefined && Math.abs(prevVal - neutralVal) >= 0.001)
        ? prevVal
        : parseFloat(sliderEl.defaultValue || neutralVal);
      sliderEl.value = target;
    } else {
      // Currently non-neutral, save and set neutral
      prevVal = cur;
      sliderEl.value = neutralVal;
    }
    formatFn(sliderEl.value);
    sendAudioUpdate();
  };
}

const valBass = document.getElementById('val-bass');
const valHpf = document.getElementById('val-hpf');
const valMid = document.getElementById('val-mid');
const valHigh = document.getElementById('val-high');
const valGain = document.getElementById('val-gain');
const valPitch = document.getElementById('val-pitch');

if (valBass) setupValueToggle(valBass, sliderBass, 0, (v) => { valBass.textContent = `+${parseFloat(v).toFixed(1)} dB`; });
if (valHpf) setupValueToggle(valHpf, sliderHpf, 20, (v) => { valHpf.textContent = `${Math.round(v)} Hz`; });
if (valMid) setupValueToggle(valMid, sliderMid, 0, (v) => { const n = parseFloat(v); valMid.textContent = `${n >= 0 ? '+' : ''}${n.toFixed(1)} dB`; });
if (valHigh) setupValueToggle(valHigh, sliderHigh, 0, (v) => { const n = parseFloat(v); valHigh.textContent = `${n >= 0 ? '+' : ''}${n.toFixed(1)} dB`; });
if (valGain) setupValueToggle(valGain, sliderGain, 1.0, (v) => { valGain.textContent = `${Math.round(parseFloat(v) * 100)}%`; });
if (valPitch) setupValueToggle(valPitch, sliderPitch, 1.0, (v) => {
  valPitch.textContent = `${parseFloat(v).toFixed(2)}x`;
  if (isEqActive) {
    findActiveTab().then(tabId => {
      if (tabId) chrome.tabs.sendMessage(tabId, { type: 'SET_SPEED', speed: parseFloat(v) });
    });
  }
});

sliderBass.oninput = (e) => {
  document.getElementById('val-bass').textContent = `+${parseFloat(e.target.value).toFixed(1)} dB`;
  sendAudioUpdate();
};
sliderHpf.oninput = (e) => {
  document.getElementById('val-hpf').textContent = `${Math.round(e.target.value)} Hz`;
  sendAudioUpdate();
};
sliderMid.oninput = (e) => {
  const v = parseFloat(e.target.value);
  document.getElementById('val-mid').textContent = `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
  sendAudioUpdate();
};
sliderHigh.oninput = (e) => {
  const v = parseFloat(e.target.value);
  document.getElementById('val-high').textContent = `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
  sendAudioUpdate();
};
sliderGain.oninput = (e) => {
  document.getElementById('val-gain').textContent = `${Math.round(e.target.value * 100)}%`;
  sendAudioUpdate();
};
sliderPitch.oninput = (e) => {
  const val = parseFloat(e.target.value);
  document.getElementById('val-pitch').textContent = `${val.toFixed(2)}x`;
  if (isEqActive) {
    findActiveTab().then(tabId => {
      if (tabId) chrome.tabs.sendMessage(tabId, { type: 'SET_SPEED', speed: val });
    });
  }
};
toggleAutoBalance.onchange = () => {
  sendAudioUpdate();
};
