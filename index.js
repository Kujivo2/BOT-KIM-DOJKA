require("dotenv").config();

const path = require("path");
const fs = require("fs/promises");
const express = require("express");
const {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits
} = require("discord.js");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const CONFIG_PATH = path.join(__dirname, "config.json");
const MAX_LOGS = 50;
const EVENT_DEDUPE_MS = 15000;
const eventLogs = [];
const recentEvents = new Map();
let loginError = "";
let loginStarted = false;

function waitForClientReady(timeoutMs = 4000) {
  if (client.isReady() || loginError || !loginStarted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);

    client.once(Events.ClientReady, () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

const defaultConfig = {
  modules: {
    welcome: true,
    leave: true,
    logs: true
  },
  welcomeChannelId: "",
  leaveChannelId: "",
  logsChannelId: "",
  welcomeTitle: "Bienvenue !",
  welcomeMessage: "Bienvenue {user} sur {server} !",
  leaveTitle: "Au revoir !",
  leaveMessage: "{user} a quitte le serveur.",
  embedColor: "#8b5cf6",
  welcomeImageUrl: "",
  leaveImageUrl: ""
};

async function getPrimaryGuild() {
  await waitForClientReady();
  if (!client.isReady()) return null;

  const cachedGuild = client.guilds.cache.first();
  if (cachedGuild) return cachedGuild;

  const guilds = await client.guilds.fetch().catch(() => null);
  const firstGuild = guilds?.first();
  return firstGuild ? client.guilds.fetch(firstGuild.id).catch(() => null) : null;
}

async function getTextChannels(guild) {
  if (!guild) return [];

  const channelCache = await guild.channels.fetch().catch(() => guild.channels.cache);

  return channelCache
    .filter((channel) => channel && (
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement
    ))
    .sort((first, second) => first.rawPosition - second.rawPosition)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type
    }));
}

async function getConnectedGuilds() {
  await waitForClientReady();
  if (!client.isReady()) return [];

  const guilds = [];

  for (const guild of client.guilds.cache.values()) {
    guilds.push({
      ...serializeGuild(guild),
      channels: await getTextChannels(guild)
    });
  }

  return guilds;
}

function sanitizeConfig(input = {}) {
  const modules = {
    ...defaultConfig.modules,
    ...(input.modules || {})
  };

  const config = {
    ...defaultConfig,
    ...input,
    modules: {
      welcome: Boolean(modules.welcome),
      leave: Boolean(modules.leave),
      logs: Boolean(modules.logs)
    },
    welcomeChannelId: String(input.welcomeChannelId || "").trim(),
    leaveChannelId: String(input.leaveChannelId || "").trim(),
    logsChannelId: String(input.logsChannelId || "").trim(),
    welcomeTitle: String(input.welcomeTitle || defaultConfig.welcomeTitle).trim(),
    welcomeMessage: String(input.welcomeMessage || defaultConfig.welcomeMessage).trim(),
    leaveTitle: String(input.leaveTitle || defaultConfig.leaveTitle).trim(),
    leaveMessage: String(input.leaveMessage || defaultConfig.leaveMessage).trim(),
    embedColor: String(input.embedColor || defaultConfig.embedColor).trim(),
    welcomeImageUrl: String(input.welcomeImageUrl || "").trim(),
    leaveImageUrl: String(input.leaveImageUrl || "").trim()
  };

  if (!/^#[0-9a-f]{6}$/i.test(config.embedColor)) {
    config.embedColor = defaultConfig.embedColor;
  }

  return config;
}

function isValidMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getEmbedImageUrl(config, type) {
  const url = type === "welcome" ? config.welcomeImageUrl : config.leaveImageUrl;
  return isValidMediaUrl(url) ? url : "";
}

function replaceTags(text, memberOrGuild) {
  const user = memberOrGuild.user ? memberOrGuild.user : null;
  const guild = memberOrGuild.guild || memberOrGuild;
  const memberCount = guild.memberCount || guild.approximateMemberCount || 0;

  return String(text || "")
    .replaceAll("{user}", user ? `<@${user.id}>` : "@Utilisateur")
    .replaceAll("{username}", user ? user.username : "Utilisateur")
    .replaceAll("{server}", guild.name || "Serveur Discord")
    .replaceAll("{memberCount}", String(memberCount));
}

function buildMemberEmbed(config, memberOrGuild, type) {
  const isWelcome = type === "welcome";
  const imageUrl = getEmbedImageUrl(config, type);

  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle(replaceTags(isWelcome ? config.welcomeTitle : config.leaveTitle, memberOrGuild))
    .setDescription(replaceTags(isWelcome ? config.welcomeMessage : config.leaveMessage, memberOrGuild))
    .setFooter({ text: `${memberOrGuild.guild?.memberCount || memberOrGuild.memberCount || 0} membres` })
    .setTimestamp();

  if (imageUrl) {
    embed.setImage(imageUrl);
  }

  return embed;
}

function pushLog(type, member) {
  const entry = {
    id: `${Date.now()}-${member.id}`,
    type,
    username: member.user.tag,
    userId: member.id,
    guildName: member.guild.name,
    createdAt: new Date().toISOString()
  };

  eventLogs.unshift(entry);
  eventLogs.splice(MAX_LOGS);
}

function shouldHandleMemberEvent(type, member) {
  const key = `${type}:${member.guild.id}:${member.id}`;
  const now = Date.now();
  const lastSeen = recentEvents.get(key);

  if (lastSeen && now - lastSeen < EVENT_DEDUPE_MS) {
    return false;
  }

  recentEvents.set(key, now);

  for (const [eventKey, timestamp] of recentEvents.entries()) {
    if (now - timestamp > EVENT_DEDUPE_MS) {
      recentEvents.delete(eventKey);
    }
  }

  return true;
}

async function readConfig() {
  try {
    const rawConfig = await fs.readFile(CONFIG_PATH, "utf8");
    return sanitizeConfig(JSON.parse(rawConfig));
  } catch (error) {
    console.error("Impossible de lire config.json, config par defaut utilisee.", error);
    return defaultConfig;
  }
}

async function writeConfig(config) {
  const nextConfig = sanitizeConfig(config);
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return nextConfig;
}

async function fetchTextChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

async function sendLogMessage(config, member, type) {
  if (!config.modules.logs || !config.logsChannelId) return;

  const channel = await fetchTextChannel(member.guild, config.logsChannelId);
  if (!channel) return;

  const label = type === "join" ? "Join" : "Leave";
  await channel.send(`${label}: ${member.user.tag} (${member.id})`);
}

async function sendMemberEmbed(member, type) {
  const config = await readConfig();
  const isWelcome = type === "welcome";

  if (isWelcome && !config.modules.welcome) return;
  if (!isWelcome && !config.modules.leave) return;

  const channelId = isWelcome
    ? config.welcomeChannelId || process.env.WELCOME_CHANNEL_ID
    : config.leaveChannelId;
  const channel = await fetchTextChannel(member.guild, channelId);

  if (!channel) return;

  const embed = buildMemberEmbed(config, member, type)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }));

  await channel.send({ embeds: [embed] });
}

function serializeGuild(guild) {
  if (!guild) {
    return {
      ready: client.isReady(),
      id: "",
      name: "Aucun serveur",
      iconUrl: "",
      memberCount: 0,
      loginError,
      loginStarted
    };
  }

  return {
    ready: client.isReady(),
    id: guild.id,
    name: guild.name,
    iconUrl: guild.iconURL({ size: 128 }) || "",
    memberCount: guild.memberCount,
    loginError,
    loginStarted
  };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

client.once(Events.ClientReady, () => {
  console.log(`Connecte en tant que ${client.user.tag}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (!shouldHandleMemberEvent("join", member)) return;

  pushLog("join", member);

  try {
    const config = await readConfig();
    await Promise.all([
      sendMemberEmbed(member, "welcome"),
      sendLogMessage(config, member, "join")
    ]);
  } catch (error) {
    console.error(error);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  if (!shouldHandleMemberEvent("leave", member)) return;

  pushLog("leave", member);

  try {
    const config = await readConfig();
    await Promise.all([
      sendMemberEmbed(member, "leave"),
      sendLogMessage(config, member, "leave")
    ]);
  } catch (error) {
    console.error(error);
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", async (req, res) => {
  res.json(await readConfig());
});

app.put("/api/config", async (req, res) => {
  try {
    const config = await writeConfig(req.body);
    res.json({ ok: true, config });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: "Impossible de sauvegarder la configuration." });
  }
});

app.get("/api/guild", async (req, res) => {
  const guild = await getPrimaryGuild();

  res.json({
    botName: client.user?.tag || "Bot hors ligne",
    guild: serializeGuild(guild)
  });
});

app.get("/api/guilds", async (req, res) => {
  res.json({
    ready: client.isReady(),
    botTag: client.user?.tag || null,
    guilds: await getConnectedGuilds(),
    loginError,
    loginStarted
  });
});

app.get("/api/channels", async (req, res) => {
  const guild = await getPrimaryGuild();

  if (!guild) {
    res.json([]);
    return;
  }

  res.json(await getTextChannels(guild));
});

app.get("/api/logs", (req, res) => {
  res.json(eventLogs);
});

app.post("/api/test-embed", async (req, res) => {
  try {
    const config = sanitizeConfig(req.body.config || await readConfig());
    const type = req.body.type === "leave" ? "leave" : "welcome";
    const guild = await getPrimaryGuild();
    const channelId = req.body.channelId || (type === "welcome" ? config.welcomeChannelId : config.leaveChannelId);
    const channel = await fetchTextChannel(guild, channelId);

    if (!guild || !channel) {
      res.status(400).json({ ok: false, message: "Salon introuvable ou bot non connecte." });
      return;
    }

    const embed = buildMemberEmbed(config, guild, type)
      .setThumbnail(guild.iconURL({ size: 256 }) || client.user.displayAvatarURL({ size: 256 }))
      .setAuthor({
        name: guild.name,
        iconURL: guild.iconURL({ size: 128 }) || undefined
      });

    await channel.send({ content: "Test embed depuis le dashboard", embeds: [embed] });
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: "Impossible d'envoyer le test embed." });
  }
});

app.get("/api/status", async (req, res) => {
  await waitForClientReady(1500);

  res.json({
    ready: client.isReady(),
    userTag: client.user?.tag || null,
    botTag: client.user?.tag || null,
    botName: client.user?.tag || "Bot hors ligne",
    guilds: client.guilds.cache.size,
    loginError,
    loginStarted
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    ready: client.isReady(),
    uptime: process.uptime()
  });
});

function loginDiscord() {
  if (!process.env.TOKEN) {
    loginError = "TOKEN manquant dans .env.";
    console.error("TOKEN manquant dans .env, dashboard lance sans connexion Discord.");
    return;
  }

  loginStarted = true;
  client.login(process.env.TOKEN).catch((error) => {
    loginError = error.message;
    console.error("Connexion Discord impossible, dashboard lance en mode hors ligne.", error.message);
  });
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Dashboard disponible sur http://localhost:${PORT}`);
  loginDiscord();
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} deja utilise. Deuxieme instance arretee pour eviter les messages en double.`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
