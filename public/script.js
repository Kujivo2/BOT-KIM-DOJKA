const form = document.querySelector("#config-form");
const notice = document.querySelector("#notice");
const statusEl = document.querySelector("#status");
const botNameEl = document.querySelector("#bot-name");
const serverNameEl = document.querySelector("#server-name");
const serverMetaEl = document.querySelector("#server-meta");
const serverAvatarEl = document.querySelector("#server-avatar");
const logsList = document.querySelector("#logs-list");
const previewButtons = document.querySelectorAll("[data-preview-type]");
let previewType = "welcome";
let currentChannels = [];

const preview = {
  line: document.querySelector(".embed-line"),
  title: document.querySelector("#preview-title"),
  message: document.querySelector("#preview-message"),
  footer: document.querySelector("#preview-footer")
};

function fakeTags(value) {
  return String(value || "")
    .replaceAll("{user}", "@Safouane")
    .replaceAll("{username}", "Safouane")
    .replaceAll("{server}", serverNameEl.textContent || "Mon serveur")
    .replaceAll("{memberCount}", "42");
}

function getField(name) {
  return form.elements[name];
}

function getFormConfig() {
  return {
    modules: {
      welcome: getField("modules.welcome").checked,
      leave: getField("modules.leave").checked,
      logs: getField("modules.logs").checked
    },
    welcomeChannelId: getField("welcomeChannelId").value,
    leaveChannelId: getField("leaveChannelId").value,
    logsChannelId: getField("logsChannelId").value,
    welcomeTitle: getField("welcomeTitle").value,
    welcomeMessage: getField("welcomeMessage").value,
    leaveTitle: getField("leaveTitle").value,
    leaveMessage: getField("leaveMessage").value,
    embedColor: getField("embedColor").value
  };
}

function setFormConfig(config) {
  getField("modules.welcome").checked = Boolean(config.modules?.welcome);
  getField("modules.leave").checked = Boolean(config.modules?.leave);
  getField("modules.logs").checked = Boolean(config.modules?.logs);

  for (const key of [
    "welcomeChannelId",
    "leaveChannelId",
    "logsChannelId",
    "welcomeTitle",
    "welcomeMessage",
    "leaveTitle",
    "leaveMessage",
    "embedColor"
  ]) {
    if (getField(key)) {
      getField(key).value = config[key] || "";
    }
  }
}

function fillChannelSelect(select, selectedValue) {
  select.replaceChildren(new Option("Aucun salon", ""));

  for (const channel of currentChannels) {
    select.append(new Option(`# ${channel.name}`, channel.id));
  }

  select.value = selectedValue || "";
}

function fillChannelSelects(config = getFormConfig()) {
  fillChannelSelect(getField("welcomeChannelId"), config.welcomeChannelId);
  fillChannelSelect(getField("leaveChannelId"), config.leaveChannelId);
  fillChannelSelect(getField("logsChannelId"), config.logsChannelId);
}

function updatePreview() {
  const config = getFormConfig();
  const isWelcome = previewType === "welcome";
  preview.line.style.background = config.embedColor || "#8b5cf6";
  preview.title.textContent = fakeTags(isWelcome ? config.welcomeTitle : config.leaveTitle);
  preview.message.textContent = fakeTags(isWelcome ? config.welcomeMessage : config.leaveMessage);
  preview.footer.textContent = "42 membres";
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("error", isError);

  if (message) {
    setTimeout(() => {
      notice.textContent = "";
      notice.classList.remove("error");
    }, 2600);
  }
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  setFormConfig(config);
  fillChannelSelects(config);
  updatePreview();
}

async function loadChannels() {
  const response = await fetch("/api/channels");
  currentChannels = await response.json();
  fillChannelSelects();
}

async function loadGuild() {
  const response = await fetch("/api/guild");
  const data = await response.json();
  const guild = data.guild;

  botNameEl.textContent = data.botName;
  statusEl.textContent = guild.ready ? "Connecte" : "Hors ligne";
  serverNameEl.textContent = guild.name;
  serverMetaEl.textContent = `${guild.memberCount || 0} membres`;

  if (guild.iconUrl) {
    serverAvatarEl.src = guild.iconUrl;
    serverAvatarEl.hidden = false;
  } else {
    serverAvatarEl.hidden = true;
  }

  updatePreview();
}

async function loadLogs() {
  const response = await fetch("/api/logs");
  const logs = await response.json();

  if (!logs.length) {
    logsList.innerHTML = '<p class="empty">Aucun join/leave pour le moment.</p>';
    return;
  }

  logsList.innerHTML = logs.map((log) => {
    const date = new Date(log.createdAt).toLocaleString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit"
    });
    const label = log.type === "join" ? "Join" : "Leave";
    return `
      <article class="log-item">
        <span class="log-type ${log.type}">${label}</span>
        <div>
          <strong>${log.username}</strong>
          <p>${date} - ${log.guildName}</p>
        </div>
      </article>
    `;
  }).join("");
}

async function saveConfig() {
  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(getFormConfig())
  });

  if (!response.ok) {
    throw new Error("Save failed");
  }

  const data = await response.json();
  setFormConfig(data.config);
  fillChannelSelects(data.config);
  updatePreview();
}

async function sendTestEmbed(type) {
  const config = getFormConfig();
  const channelId = type === "welcome" ? config.welcomeChannelId : config.leaveChannelId;

  const response = await fetch("/api/test-embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, channelId, config })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || "Test failed");
  }
}

form.addEventListener("input", updatePreview);
form.addEventListener("change", updatePreview);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showNotice("Sauvegarde...");

  try {
    await saveConfig();
    showNotice("Configuration sauvegardee.");
  } catch (error) {
    showNotice("Erreur pendant la sauvegarde.", true);
  }
});

document.querySelector("#refresh-channels").addEventListener("click", async () => {
  await loadChannels();
  showNotice("Liste des salons mise a jour.");
});

document.querySelector("#refresh-logs").addEventListener("click", loadLogs);

document.querySelector("#test-welcome").addEventListener("click", async () => {
  try {
    await sendTestEmbed("welcome");
    showNotice("Test bienvenue envoye.");
  } catch (error) {
    showNotice(error.message, true);
  }
});

document.querySelector("#test-leave").addEventListener("click", async () => {
  try {
    await sendTestEmbed("leave");
    showNotice("Test depart envoye.");
  } catch (error) {
    showNotice(error.message, true);
  }
});

for (const button of previewButtons) {
  button.addEventListener("click", () => {
    previewType = button.dataset.previewType;
    previewButtons.forEach((item) => item.classList.toggle("active", item === button));
    updatePreview();
  });
}

document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
  });
});

Promise.all([loadGuild(), loadChannels(), loadConfig(), loadLogs()]).catch(() => {
  showNotice("Impossible de charger le dashboard.", true);
});

setInterval(loadGuild, 10000);
setInterval(loadLogs, 15000);
