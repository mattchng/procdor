(function () {
  const { RULES, defaultRuleState } = window.ProcdorCompress;
  const container = document.getElementById("rules");

  const pasteToggle = document.getElementById("pasteIntercept");
  const attachToggle = document.getElementById("pasteAttach");
  chrome.storage.sync.get(
    ["procdorPasteIntercept", "procdorPasteAttach"],
    (d) => {
      pasteToggle.checked = d.procdorPasteIntercept !== false; // default on
      attachToggle.checked = d.procdorPasteAttach !== false;   // default on
      attachToggle.disabled = !pasteToggle.checked;
    }
  );
  pasteToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ procdorPasteIntercept: pasteToggle.checked });
    attachToggle.disabled = !pasteToggle.checked;
  });
  attachToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ procdorPasteAttach: attachToggle.checked });
  });

  chrome.storage.sync.get("procdorRules", (data) => {
    const state = Object.assign(defaultRuleState(), data.procdorRules || {});

    RULES.forEach((rule) => {
      const label = document.createElement("label");

      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = state[rule.id];
      input.addEventListener("change", () => {
        state[rule.id] = input.checked;
        chrome.storage.sync.set({ procdorRules: state });
      });

      const text = document.createElement("div");
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = rule.name;
      const desc = document.createElement("div");
      desc.className = "desc";
      desc.textContent = rule.desc;
      text.appendChild(name);
      text.appendChild(desc);

      label.appendChild(input);
      label.appendChild(text);
      container.appendChild(label);
    });
  });
})();
