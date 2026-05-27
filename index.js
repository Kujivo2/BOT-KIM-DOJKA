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
const CONFIG_PATH = path.join(__dirname, "config.json");
const MAX_LOGS = 50;
const eventLogs = [];

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
  embedColor: "#8b5cf6"
};

function getPrimaryGuild() {
  return client.guilds.cache.first() || null;
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
    embedColor: String(input.embedColor || defaultConfig.embedColor).trim()
  };

  if (!/^#[0-9a-f]{6}$/i.test(config.embedColor)) {
    config.embedColor = defaultConfig.embedColor;
  }

  return config;
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

  return new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle(replaceTags(isWelcome ? config.welcomeTitle : config.leaveTitle, memberOrGuild))
    .setDescription(replaceTags(isWelcome ? config.welcomeMessage : config.leaveMessage, memberOrGuild))
    .setFooter({ text: `${memberOrGuild.guild?.memberCount || memberOrGuild.memberCount || 0} membres` })
    .setTimestamp();
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
      memberCount: 0
    };
  }

  return {
    ready: client.isReady(),
    id: guild.id,
    name: guild.name,
    iconUrl: guild.iconURL({ size: 128 }) || "",
    memberCount: guild.memberCount
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

app.get("/api/guild", (req, res) => {
  res.json({
    botName: client.user?.tag || "Bot hors ligne",
    guild: serializeGuild(getPrimaryGuild())
  });
});

app.get("/api/channels", async (req, res) => {
  const guild = getPrimaryGuild();

  if (!guild) {
    res.json([]);
    return;
  }

  const channels = guild.channels.cache
    .filter((channel) => (
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement
    ))
    .sort((first, second) => first.rawPosition - second.rawPosition)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type
    }));

  res.json(channels);
});

app.get("/api/logs", (req, res) => {
  res.json(eventLogs);
});

app.post("/api/test-embed", async (req, res) => {
  try {
    const config = sanitizeConfig(req.body.config || await readConfig());
    const type = req.body.type === "leave" ? "leave" : "welcome";
    const guild = getPrimaryGuild();
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

app.get("/api/status", (req, res) => {
  res.json({
    ready: client.isReady(),
    botName: client.user?.tag || "Bot hors ligne",
    guilds: client.guilds.cache.size
  });
});

app.listen(PORT, () => {
  console.log(`Dashboard disponible sur http://localhost:${PORT}`);
});

client.login(process.env.TOKEN);
