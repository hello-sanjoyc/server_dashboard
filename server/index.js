import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import express from "express";
import nodemailer from "nodemailer";
import si from "systeminformation";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const config = {
    port: Number(process.env.PORT || 9999),
    host: process.env.HOST || "127.0.0.1",
    appSecret: process.env.APP_SECRET || "local-development-secret-change-me",
    cookieSecure: String(process.env.COOKIE_SECURE || "false") === "true",
    username: process.env.DASHBOARD_USERNAME || "admin",
    password: process.env.DASHBOARD_PASSWORD || "change-this-password",
    networkInterface: process.env.NETWORK_INTERFACE || "*",
    refreshSeconds: Number(process.env.DASHBOARD_REFRESH_SECONDS || 60),
    alertIntervalSeconds: Number(
        process.env.ALERT_CHECK_INTERVAL_SECONDS || 60,
    ),
    cpuThreshold: Number(process.env.ALERT_CPU_THRESHOLD_PERCENT || 50),
    ramThreshold: Number(process.env.ALERT_RAM_THRESHOLD_PERCENT || 50),
    alertCooldownMinutes: Number(process.env.ALERT_COOLDOWN_MINUTES || 15),
    smtpHost: process.env.SMTP_HOST,
    smtpPort: Number(process.env.SMTP_PORT || 587),
    smtpSecure: String(process.env.SMTP_SECURE || "false") === "true",
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    emailFrom: process.env.EMAIL_FROM,
    emailTo: process.env.EMAIL_TO,
    pm2Home: process.env.PM2_HOME,
};

const app = express();
const alertCooldowns = new Map();

app.use(express.json());
app.use(cookieParser());

function base64Url(input) {
    return Buffer.from(input).toString("base64url");
}

function signPayload(payload) {
    const body = base64Url(JSON.stringify(payload));
    const signature = crypto
        .createHmac("sha256", config.appSecret)
        .update(body)
        .digest("base64url");
    return `${body}.${signature}`;
}

function readSignedPayload(token) {
    if (!token || !token.includes(".")) return null;

    const [body, signature] = token.split(".");
    const expected = crypto
        .createHmac("sha256", config.appSecret)
        .update(body)
        .digest("base64url");

    if (
        signature.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
        return null;
    }

    try {
        const payload = JSON.parse(
            Buffer.from(body, "base64url").toString("utf8"),
        );
        if (payload.exp && Date.now() > payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}

function requireAuth(req, res, next) {
    const payload = readSignedPayload(req.cookies.monitor_token);
    if (!payload?.user) {
        return res.status(401).json({ message: "Authentication required" });
    }
    req.user = payload.user;
    return next();
}

function toFixedNumber(value, digits = 2) {
    if (!Number.isFinite(value)) return 0;
    return Number(value.toFixed(digits));
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1,
    );
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

async function withPm2List() {
    if (config.pm2Home) {
        process.env.PM2_HOME = config.pm2Home;
    }

    const { default: pm2 } = await import("pm2");

    return new Promise((resolve, reject) => {
        pm2.connect((connectError) => {
            if (connectError) return reject(connectError);
            pm2.list((listError, list) => {
                pm2.disconnect();
                if (listError) return reject(listError);
                return resolve(list || []);
            });
        });
    });
}

async function getSystemMetrics() {
    const [loadResult, memoryResult, networkResult] = await Promise.allSettled([
        si.currentLoad(),
        si.mem(),
        si.networkStats(config.networkInterface),
    ]);

    const load = loadResult.status === "fulfilled" ? loadResult.value : null;
    const memory =
        memoryResult.status === "fulfilled"
            ? memoryResult.value
            : {
                  total: os.totalmem(),
                  active: os.totalmem() - os.freemem(),
                  available: os.freemem(),
              };
    const networkStats =
        networkResult.status === "fulfilled" ? networkResult.value : [];
    const interfaces = Array.isArray(networkStats)
        ? networkStats
        : [networkStats];
    const network = interfaces.reduce(
        (acc, item) => ({
            rxBytes: acc.rxBytes + Number(item.rx_bytes || 0),
            txBytes: acc.txBytes + Number(item.tx_bytes || 0),
            rxPerSecond: acc.rxPerSecond + Number(item.rx_sec || 0),
            txPerSecond: acc.txPerSecond + Number(item.tx_sec || 0),
        }),
        { rxBytes: 0, txBytes: 0, rxPerSecond: 0, txPerSecond: 0 },
    );

    return {
        cpu: {
            usagePercent: toFixedNumber(load?.currentLoad || 0),
        },
        memory: {
            totalBytes: memory.total,
            usedBytes: memory.active,
            freeBytes: memory.available,
            usagePercent: toFixedNumber((memory.active / memory.total) * 100),
        },
        network: {
            interface: config.networkInterface,
            incomingBytes: network.rxBytes,
            outgoingBytes: network.txBytes,
            incomingPerSecondBytes: Math.max(0, network.rxPerSecond),
            outgoingPerSecondBytes: Math.max(0, network.txPerSecond),
        },
        warnings: [
            loadResult.status === "rejected"
                ? `CPU metrics unavailable: ${loadResult.reason.message}`
                : null,
            memoryResult.status === "rejected"
                ? `Memory metrics used OS fallback: ${memoryResult.reason.message}`
                : null,
            networkResult.status === "rejected"
                ? `Network metrics unavailable: ${networkResult.reason.message}`
                : null,
        ].filter(Boolean),
    };
}

async function getPm2ProcessMetrics(totalMemoryBytes = os.totalmem()) {
    const list = await withPm2List();

    return list.map((processInfo) => {
        const memoryBytes = Number(processInfo.monit?.memory || 0);
        const ramPercent =
            totalMemoryBytes > 0 ? (memoryBytes / totalMemoryBytes) * 100 : 0;

        return {
            id: processInfo.pm_id,
            name: processInfo.name,
            namespace: processInfo.pm2_env?.namespace || "default",
            pid: processInfo.pid,
            status: processInfo.pm2_env?.status || "unknown",
            restartCount: processInfo.pm2_env?.restart_time || 0,
            uptime: processInfo.pm2_env?.pm_uptime || null,
            cpuPercent: toFixedNumber(Number(processInfo.monit?.cpu || 0)),
            ramBytes: memoryBytes,
            ramPercent: toFixedNumber(ramPercent),
            ramHuman: formatBytes(memoryBytes),
        };
    });
}

async function getMetrics() {
    const system = await getSystemMetrics();
    let processes = [];
    let pm2Error = null;

    try {
        processes = await getPm2ProcessMetrics(system.memory.totalBytes);
    } catch (error) {
        pm2Error = error.message;
    }

    return {
        generatedAt: new Date().toISOString(),
        refreshSeconds: config.refreshSeconds,
        thresholds: {
            cpuPercent: config.cpuThreshold,
            ramPercent: config.ramThreshold,
        },
        system,
        pm2: processes,
        pm2Error,
    };
}

function buildTransporter() {
    if (!config.smtpHost || !config.emailFrom || !config.emailTo) return null;

    return nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        auth: config.smtpUser
            ? {
                  user: config.smtpUser,
                  pass: config.smtpPass,
              }
            : undefined,
    });
}

function shouldSendAlert(processMetric) {
    const isOverThreshold =
        processMetric.cpuPercent > config.cpuThreshold ||
        processMetric.ramPercent > config.ramThreshold;

    if (!isOverThreshold) return false;

    const key = `${processMetric.id}:${processMetric.name}`;
    const lastSentAt = alertCooldowns.get(key) || 0;
    const cooldownMs = config.alertCooldownMinutes * 60 * 1000;

    if (Date.now() - lastSentAt < cooldownMs) return false;
    alertCooldowns.set(key, Date.now());
    return true;
}

async function sendAlertEmail(processes) {
    const transporter = buildTransporter();
    if (!transporter) {
        console.warn(
            "Alert skipped: SMTP_HOST, EMAIL_FROM, and EMAIL_TO must be configured.",
        );
        return;
    }

    const rows = processes
        .map(
            (item) =>
                `${item.name} (pm_id: ${item.id}, status: ${item.status}) CPU: ${item.cpuPercent}% RAM: ${item.ramPercent}% (${item.ramHuman})`,
        )
        .join("\n");

    await transporter.sendMail({
        from: config.emailFrom,
        to: config.emailTo,
        subject: `PM2 resource alert: ${processes.length} process(es) over threshold`,
        text: `The following PM2 process(es) exceeded configured thresholds.\n\nCPU threshold: ${config.cpuThreshold}%\nRAM threshold: ${config.ramThreshold}%\n\n${rows}\n\nGenerated at: ${new Date().toISOString()}`,
    });
}

async function checkAlerts() {
    try {
        const metrics = await getMetrics();
        const offenders = metrics.pm2.filter(shouldSendAlert);
        if (offenders.length > 0) {
            await sendAlertEmail(offenders);
        }
    } catch (error) {
        console.error("Alert check failed:", error.message);
    }
}

app.post("/api/login", (req, res) => {
    const { username, password } = req.body || {};
    if (username !== config.username || password !== config.password) {
        return res
            .status(401)
            .json({ message: "Invalid username or password" });
    }

    const token = signPayload({
        user: username,
        exp: Date.now() + 12 * 60 * 60 * 1000,
    });

    res.cookie("monitor_token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: config.cookieSecure,
        maxAge: 12 * 60 * 60 * 1000,
    });
    return res.json({ username });
});

app.post("/api/logout", (req, res) => {
    res.clearCookie("monitor_token");
    return res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
    return res.json({ username: req.user });
});

app.get("/api/metrics", requireAuth, async (req, res) => {
    try {
        const metrics = await getMetrics();
        return res.json(metrics);
    } catch (error) {
        return res.status(500).json({
            message: "Unable to read metrics",
            detail: error.message,
        });
    }
});

const distPath = path.join(projectRoot, "dist");
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get(/.*/, (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
    });
}

app.listen(config.port, config.host, () => {
    console.log(
        `Dashboard API listening on http://${config.host}:${config.port}`,
    );
    checkAlerts();
    setInterval(checkAlerts, config.alertIntervalSeconds * 1000);
});
