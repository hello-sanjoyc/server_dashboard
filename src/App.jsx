import { useEffect, useMemo, useState } from "react";

const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL || "";
const apiBaseUrl = configuredApiBaseUrl
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1,
    );
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatDate(value) {
    if (!value) return "-";
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
    }).format(new Date(value));
}

function ageFromTimestamp(timestamp) {
    if (!timestamp) return "-";
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

async function apiRequest(path, options = {}) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
        ...options,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.message || "Request failed");
    }
    return data;
}

function validateMetrics(data) {
    if (!data?.system?.cpu || !data?.system?.memory || !data?.system?.network) {
        throw new Error("Metrics response is missing system data");
    }
    if (!Array.isArray(data.pm2)) {
        throw new Error("Metrics response is missing PM2 process data");
    }
    return data;
}

function MetricCard({ label, value, detail, tone, meterValue, threshold }) {
    const hasMeter = Number.isFinite(Number(meterValue));

    return (
        <section
            className={`metric-card ${tone || ""} ${hasMeter ? "metered" : ""}`}
        >
            <div className="metric-label">
                <p>{label}</p>
                <span aria-hidden="true" />
            </div>
            <strong>{value}</strong>
            {hasMeter && (
                <UsageBar value={meterValue} threshold={threshold || 100} />
            )}
            <small>{detail}</small>
        </section>
    );
}

function UsageBar({ value, threshold }) {
    const normalized = Math.max(0, Math.min(100, Number(value) || 0));
    const danger = normalized > threshold;
    return (
        <div className="usage-bar" aria-label={`${normalized}% used`}>
            <div
                className={danger ? "danger" : ""}
                style={{ width: `${normalized}%` }}
            />
        </div>
    );
}

function Login({ onLogin }) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    async function submit(event) {
        event.preventDefault();
        setError("");
        setLoading(true);
        try {
            const session = await apiRequest("/api/login", {
                method: "POST",
                body: JSON.stringify({ username, password }),
            });
            onLogin(session);
        } catch (requestError) {
            setError(requestError.message);
        } finally {
            setLoading(false);
        }
    }

    return (
        <main className="login-shell">
            <form className="login-panel" onSubmit={submit}>
                <div className="login-brand">
                    <span className="brand-mark">PM2</span>
                    <div>
                        <p className="eyebrow">Secure monitor</p>
                        <h1>PM2 Resource Dashboard</h1>
                    </div>
                </div>
                <label>
                    Username
                    <input
                        autoComplete="username"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        required
                    />
                </label>
                <label>
                    Password
                    <input
                        autoComplete="current-password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                    />
                </label>
                {error && <p className="error">{error}</p>}
                <button type="submit" disabled={loading}>
                    {loading ? "Signing in..." : "Sign in"}
                </button>
            </form>
        </main>
    );
}

function Dashboard({ user, onLogout }) {
    const [metrics, setMetrics] = useState(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);

    const thresholds = metrics?.thresholds || {
        cpuPercent: 50,
        ramPercent: 50,
    };

    async function loadMetrics() {
        try {
            const data = validateMetrics(await apiRequest("/api/metrics"));
            setMetrics(data);
            setError("");
        } catch (requestError) {
            setError(requestError.message);
        } finally {
            setLoading(false);
        }
    }

    async function logout() {
        await apiRequest("/api/logout", { method: "POST" }).catch(() => null);
        onLogout();
    }

    useEffect(() => {
        loadMetrics();
    }, []);

    useEffect(() => {
        if (!metrics?.refreshSeconds) return undefined;
        const timer = window.setInterval(
            loadMetrics,
            metrics.refreshSeconds * 1000,
        );
        return () => window.clearInterval(timer);
    }, [metrics?.refreshSeconds]);

    const totals = useMemo(() => {
        if (!metrics?.system) return null;
        return {
            cpu: `${metrics.system.cpu.usagePercent}%`,
            ram: `${metrics.system.memory.usagePercent}%`,
            incoming: `${formatBytes(metrics.system.network.incomingPerSecondBytes)}/s`,
            outgoing: `${formatBytes(metrics.system.network.outgoingPerSecondBytes)}/s`,
        };
    }, [metrics]);

    const processSummary = useMemo(() => {
        if (!metrics?.pm2) return null;
        const online = metrics.pm2.filter(
            (process) => process.status === "online",
        ).length;
        return {
            online,
            total: metrics.pm2.length,
        };
    }, [metrics]);

    return (
        <main className="dashboard-shell">
            <header className="topbar">
                <div className="topbar-title">
                    <p className="eyebrow">Signed in as {user?.username}</p>
                    <h1>PM2 Resource Dashboard</h1>
                    {metrics && (
                        <p className="topbar-meta">
                            <span>{processSummary.online} online</span>
                            <span>{processSummary.total} total</span>
                            <span>{metrics.refreshSeconds}s refresh</span>
                        </p>
                    )}
                </div>
                <div className="topbar-actions">
                    <button
                        type="button"
                        className="secondary"
                        onClick={loadMetrics}
                    >
                        Refresh
                    </button>
                    <button type="button" className="ghost" onClick={logout}>
                        Logout
                    </button>
                </div>
            </header>

            {error && <div className="alert">{error}</div>}

            {loading && <div className="loading">Loading metrics...</div>}

            {metrics && totals && (
                <>
                    <section className="metrics-grid">
                        <MetricCard
                            label="Total CPU usage"
                            value={totals.cpu}
                            detail={`Alert threshold ${thresholds.cpuPercent}%`}
                            meterValue={metrics.system.cpu.usagePercent}
                            threshold={thresholds.cpuPercent}
                            tone={
                                metrics.system.cpu.usagePercent >
                                thresholds.cpuPercent
                                    ? "hot"
                                    : ""
                            }
                        />
                        <MetricCard
                            label="Total RAM usage"
                            value={totals.ram}
                            detail={`${formatBytes(metrics.system.memory.usedBytes)} of ${formatBytes(
                                metrics.system.memory.totalBytes,
                            )}`}
                            meterValue={metrics.system.memory.usagePercent}
                            threshold={thresholds.ramPercent}
                            tone={
                                metrics.system.memory.usagePercent >
                                thresholds.ramPercent
                                    ? "hot"
                                    : ""
                            }
                        />
                        <MetricCard
                            label="Incoming bandwidth"
                            value={totals.incoming}
                            detail={`${formatBytes(metrics.system.network.incomingBytes)} total`}
                        />
                        <MetricCard
                            label="Outgoing bandwidth"
                            value={totals.outgoing}
                            detail={`${formatBytes(metrics.system.network.outgoingBytes)} total`}
                        />
                    </section>

                    <section className="process-section">
                        <div className="section-heading">
                            <div>
                                <h2>PM2 Processes</h2>
                                <p>
                                    Updated {formatDate(metrics.generatedAt)}.
                                    Auto-refresh every {metrics.refreshSeconds}{" "}
                                    seconds.
                                </p>
                                {metrics.pm2Error && (
                                    <p className="warning">
                                        PM2 unavailable: {metrics.pm2Error}
                                    </p>
                                )}
                                {metrics.system.warnings?.map((warning) => (
                                    <p className="warning" key={warning}>
                                        {warning}
                                    </p>
                                ))}
                            </div>
                            <div className="section-stats" aria-label="Process summary">
                                <span>
                                    <strong>{processSummary.online}</strong>
                                    Online
                                </span>
                                <span>
                                    <strong>{processSummary.total}</strong>
                                    Total
                                </span>
                            </div>
                        </div>

                        <div className="table-wrap">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Status</th>
                                        <th>PID</th>
                                        <th>CPU</th>
                                        <th>RAM</th>
                                        <th>Uptime</th>
                                        <th>Restarts</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {metrics.pm2.map((process) => {
                                        const overCpu =
                                            process.cpuPercent >
                                            thresholds.cpuPercent;
                                        const overRam =
                                            process.ramPercent >
                                            thresholds.ramPercent;
                                        return (
                                            <tr
                                                key={`${process.id}-${process.name}`}
                                            >
                                                <td>
                                                    <strong>
                                                        {process.name}
                                                    </strong>
                                                    <small>
                                                        #{process.id} /{" "}
                                                        {process.namespace}
                                                    </small>
                                                </td>
                                                <td>
                                                    <span
                                                        className={`status ${process.status}`}
                                                    >
                                                        <span aria-hidden="true" />
                                                        {process.status}
                                                    </span>
                                                </td>
                                                <td>{process.pid || "-"}</td>
                                                <td>
                                                    <div className="usage-cell">
                                                        <span
                                                            className={
                                                                overCpu
                                                                    ? "danger-text"
                                                                    : ""
                                                            }
                                                        >
                                                            {process.cpuPercent}
                                                            %
                                                        </span>
                                                        <UsageBar
                                                            value={
                                                                process.cpuPercent
                                                            }
                                                            threshold={
                                                                thresholds.cpuPercent
                                                            }
                                                        />
                                                    </div>
                                                </td>
                                                <td>
                                                    <div className="usage-cell">
                                                        <span
                                                            className={
                                                                overRam
                                                                    ? "danger-text"
                                                                    : ""
                                                            }
                                                        >
                                                            {process.ramPercent}
                                                            % /{" "}
                                                            {process.ramHuman}
                                                        </span>
                                                        <UsageBar
                                                            value={
                                                                process.ramPercent
                                                            }
                                                            threshold={
                                                                thresholds.ramPercent
                                                            }
                                                        />
                                                    </div>
                                                </td>
                                                <td>
                                                    {ageFromTimestamp(
                                                        process.uptime,
                                                    )}
                                                </td>
                                                <td>{process.restartCount}</td>
                                            </tr>
                                        );
                                    })}
                                    {metrics.pm2.length === 0 && (
                                        <tr>
                                            <td colSpan="7" className="empty">
                                                No PM2 processes found.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </section>
                </>
            )}
        </main>
    );
}

export default function App() {
    const [session, setSession] = useState(null);
    const [checkingSession, setCheckingSession] = useState(true);

    useEffect(() => {
        apiRequest("/api/me")
            .then(setSession)
            .catch(() => setSession(null))
            .finally(() => setCheckingSession(false));
    }, []);

    if (checkingSession) {
        return <main className="loading fullscreen">Checking session...</main>;
    }

    if (!session) {
        return <Login onLogin={setSession} />;
    }

    return <Dashboard user={session} onLogout={() => setSession(null)} />;
}
