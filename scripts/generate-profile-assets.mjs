#!/usr/bin/env node
/**
 * Generates GitHub profile analytics SVGs from GitHub API data.
 * Used by .github/workflows/profile.yml — no external SVG CDN endpoints.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "profile");

const USERNAME = process.env.GITHUB_USERNAME || "Gautami60";
const TOKEN = process.env.GITHUB_TOKEN || "";

const THEME = {
  bg: "#0b0b10",
  card: "#12101a",
  cardAlt: "#151022",
  border: "#312e81",
  title: "#c4b5fd",
  text: "#e9d5ff",
  bright: "#f5f3ff",
  muted: "#71717a",
  accent: "#a78bfa",
  accent2: "#8b5cf6",
  accent3: "#7c3aed",
  accent4: "#6d28d9",
  line: "#4338ca",
  graphFill: "rgba(139, 92, 246, 0.25)",
  graphStroke: "#a78bfa",
  bars: ["#c4b5fd", "#a78bfa", "#8b5cf6", "#7c3aed", "#6d28d9", "#5b21b6", "#4338ca"],
};

const LANG_COLORS = {
  JavaScript: "#f7df1e",
  TypeScript: "#3178c6",
  Python: "#3572A5",
  Java: "#b07219",
  Kotlin: "#A97BFF",
  "Jupyter Notebook": "#DA5B0B",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Go: "#00ADD8",
  Rust: "#dea584",
  C: "#555555",
  "C++": "#f34b7d",
  Shell: "#89e051",
  PHP: "#4F5D95",
  Ruby: "#701516",
  Swift: "#F05138",
  Dart: "#00B4AB",
};

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function ghFetch(path, { graphql = false, body } = {}) {
  const url = graphql ? "https://api.github.com/graphql" : `https://api.github.com${path}`;
  const headers = {
    Accept: graphql ? "application/json" : "application/vnd.github+json",
    "User-Agent": "gautami60-profile-generator",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

async function fetchUser() {
  return ghFetch(`/users/${USERNAME}`);
}

async function fetchRepos() {
  const repos = [];
  let page = 1;

  while (true) {
    const batch = await ghFetch(`/users/${USERNAME}/repos?per_page=100&page=${page}&sort=updated`);
    if (!batch.length) break;
    repos.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }

  return repos.filter((repo) => !repo.fork);
}

async function fetchLanguageTotals(repos) {
  const totals = {};

  for (const repo of repos) {
    try {
      const langs = await ghFetch(`/repos/${repo.full_name}/languages`);
      for (const [lang, bytes] of Object.entries(langs)) {
        totals[lang] = (totals[lang] || 0) + bytes;
      }
    } catch {
      // Skip repos without language data.
    }
  }

  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .map(([name, bytes]) => ({ name, bytes }));
}

async function fetchContributionDataFromGraphQL() {
  const query = `
    query($username: String!) {
      user(login: $username) {
        name
        repositoriesContributedTo(includeUserRepositories: true, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
          totalCount
        }
        repositories(first: 100, ownerAffiliations: OWNER, orderBy: { field: STARGAZERS, direction: DESC }) {
          nodes { stargazers { totalCount } }
        }
        contributionsCollection {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
              }
            }
          }
        }
      }
    }
  `;

  const data = await ghFetch("", {
    graphql: true,
    body: { query, variables: { username: USERNAME } },
  });

  if (data.errors?.length) {
    throw new Error(data.errors.map((e) => e.message).join("; "));
  }

  const user = data.data.user;
  const calendar = user.contributionsCollection.contributionCalendar;
  const days = calendar.weeks.flatMap((week) => week.contributionDays);

  return {
    displayName: user.name || USERNAME,
    contributedTo: user.repositoriesContributedTo.totalCount,
    totalStars: user.repositories.nodes.reduce((sum, repo) => sum + repo.stargazers.totalCount, 0),
    totalCommitContributions: user.contributionsCollection.totalCommitContributions,
    totalIssueContributions: user.contributionsCollection.totalIssueContributions,
    totalPullRequestContributions: user.contributionsCollection.totalPullRequestContributions,
    totalPullRequestReviewContributions: user.contributionsCollection.totalPullRequestReviewContributions,
    totalContributions: calendar.totalContributions,
    days,
  };
}

async function fetchContributionDataFallback(repos, user) {
  console.warn("GraphQL unavailable — using public contribution calendar fallback for day-level data.");

  const response = await fetch(`https://github-contributions-api.jogruber.de/v4/${USERNAME}?y=last`, {
    headers: { "User-Agent": "gautami60-profile-generator" },
  });

  if (!response.ok) {
    throw new Error(`Contribution fallback failed with status ${response.status}`);
  }

  const payload = await response.json();
  const days = payload.contributions.map((entry) => ({
    date: entry.date,
    contributionCount: entry.count,
  }));

  const totalStars = repos.reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0);
  const totalCommitContributions = days.reduce((sum, day) => sum + day.contributionCount, 0);

  return {
    displayName: user.name || USERNAME,
    contributedTo: repos.length,
    totalStars,
    totalCommitContributions,
    totalIssueContributions: 0,
    totalPullRequestContributions: 0,
    totalPullRequestReviewContributions: 0,
    totalContributions: payload.total?.lastYear ?? totalCommitContributions,
    days,
  };
}

async function fetchContributionData(user, repos) {
  try {
    return await fetchContributionDataFromGraphQL();
  } catch (error) {
    console.warn(`GraphQL contribution fetch failed: ${error.message}`);
    return fetchContributionDataFallback(repos, user);
  }
}

function calculateStreaks(days) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const today = new Date().toISOString().slice(0, 10);

  let current = 0;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const day = sorted[i];
    if (day.date > today) continue;
    if (day.contributionCount > 0) {
      current += 1;
    } else if (day.date === today) {
      continue;
    } else {
      break;
    }
  }

  let longest = 0;
  let run = 0;
  for (const day of sorted) {
    if (day.contributionCount > 0) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }

  return { current, longest, total: sorted.reduce((sum, d) => sum + d.contributionCount, 0) };
}

function cardShell({ width, height, title, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="8" fill="${THEME.bg}" stroke="${THEME.border}" stroke-width="1"/>
  <text x="20" y="28" fill="${THEME.title}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="14" font-weight="600">${esc(title)}</text>
  ${body}
</svg>`;
}

function generateStatsSvg(user, contributionData) {
  const width = 495;
  const height = 195;
  const stats = [
    { label: "Total Stars", value: contributionData.totalStars },
    { label: "Total Commits", value: contributionData.totalCommitContributions },
    { label: "Total PRs", value: contributionData.totalPullRequestContributions },
    { label: "Total Issues", value: contributionData.totalIssueContributions },
    { label: "Contributed To", value: contributionData.contributedTo },
    { label: "Public Repos", value: user.public_repos },
  ];

  const cols = 2;
  const cellW = width / cols;
  const startY = 52;
  const rowH = 42;

  const cells = stats
    .map((item, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = 24 + col * cellW;
      const y = startY + row * rowH;
      return `<text x="${x}" y="${y}" fill="${THEME.bright}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="18" font-weight="700">${esc(item.value)}</text>
  <text x="${x}" y="${y + 18}" fill="${THEME.muted}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="11">${esc(item.label)}</text>`;
    })
    .join("\n  ");

  return cardShell({
    width,
    height,
    title: `${contributionData.displayName}'s GitHub Stats`,
    body: cells,
  });
}

function generateTopLangsSvg(languages) {
  const width = 495;
  const height = 195;
  const top = languages.slice(0, 6);
  const maxBytes = top[0]?.bytes || 1;

  if (!top.length) {
    return cardShell({
      width,
      height,
      title: "Most Used Languages",
      body: `<text x="20" y="80" fill="${THEME.muted}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="13">No language data available yet.</text>`,
    });
  }

  const barStartY = 48;
  const barHeight = 16;
  const gap = 22;

  const bars = top
    .map((lang, index) => {
      const y = barStartY + index * gap;
      const barW = Math.max(24, ((lang.bytes / maxBytes) * (width - 170)));
      const color = LANG_COLORS[lang.name] || THEME.bars[index % THEME.bars.length];
      const pct = ((lang.bytes / languages.reduce((s, l) => s + l.bytes, 0)) * 100).toFixed(1);
      return `<text x="20" y="${y + 12}" fill="${THEME.text}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="12">${esc(lang.name)}</text>
  <rect x="130" y="${y}" width="${barW.toFixed(1)}" height="${barHeight}" rx="4" fill="${color}" opacity="0.9"/>
  <text x="${(130 + barW + 8).toFixed(1)}" y="${y + 12}" fill="${THEME.muted}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="11">${pct}%</text>`;
    })
    .join("\n  ");

  return cardShell({
    width,
    height,
    title: "Most Used Languages",
    body: bars,
  });
}

function generateStreakSvg(streak, displayName) {
  const width = 495;
  const height = 195;
  const blocks = [
    { label: "Total Contributions", value: streak.total, x: 30 },
    { label: "Current Streak", value: `${streak.current} days`, x: 185 },
    { label: "Longest Streak", value: `${streak.longest} days`, x: 340 },
  ];

  const body = blocks
    .map(
      (block) => `<g>
    <rect x="${block.x}" y="58" width="130" height="92" rx="10" fill="${THEME.card}" stroke="${THEME.border}" stroke-width="1"/>
    <text x="${block.x + 65}" y="98" fill="${THEME.bright}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="22" font-weight="700" text-anchor="middle">${esc(block.value)}</text>
    <text x="${block.x + 65}" y="125" fill="${THEME.muted}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="11" text-anchor="middle">${esc(block.label)}</text>
  </g>`,
    )
    .join("\n  ");

  return cardShell({
    width,
    height,
    title: `${displayName}'s GitHub Streak`,
    body,
  });
}

function trophyGrade(value, thresholds) {
  if (value >= thresholds.S) return { grade: "S", color: "#f472b6" };
  if (value >= thresholds.A) return { grade: "A", color: "#a78bfa" };
  if (value >= thresholds.B) return { grade: "B", color: "#818cf8" };
  if (value >= thresholds.C) return { grade: "C", color: "#6366f1" };
  return { grade: "None", color: "#3f3f46" };
}

function generateTrophiesSvg(metrics) {
  const width = 900;
  const height = 130;
  const trophies = [
    { title: "Stars", value: metrics.totalStars, thresholds: { C: 1, B: 5, A: 20, S: 50 } },
    { title: "Commits", value: metrics.totalCommitContributions, thresholds: { C: 10, B: 100, A: 500, S: 1000 } },
    { title: "Repos", value: metrics.publicRepos, thresholds: { C: 5, B: 10, A: 20, S: 50 } },
    { title: "Followers", value: metrics.followers, thresholds: { C: 1, B: 5, A: 20, S: 50 } },
    { title: "Issues", value: metrics.totalIssueContributions, thresholds: { C: 1, B: 10, A: 50, S: 100 } },
    { title: "PRs", value: metrics.totalPullRequestContributions, thresholds: { C: 1, B: 10, A: 50, S: 100 } },
  ];

  const cellW = width / trophies.length;
  const cells = trophies
    .map((item, index) => {
      const { grade, color } = trophyGrade(item.value, item.thresholds);
      const cx = index * cellW + cellW / 2;
      return `<g transform="translate(${cx - 55}, 18)">
    <rect width="110" height="92" rx="10" fill="${THEME.cardAlt}" stroke="${THEME.border}" stroke-width="1"/>
    <circle cx="55" cy="30" r="18" fill="${color}" opacity="${grade === "None" ? 0.35 : 0.95}"/>
    <text x="55" y="36" fill="${THEME.bright}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="16" font-weight="700" text-anchor="middle">${esc(grade)}</text>
    <text x="55" y="62" fill="${THEME.text}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="12" font-weight="600" text-anchor="middle">${esc(item.title)}</text>
    <text x="55" y="80" fill="${THEME.muted}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="11" text-anchor="middle">${esc(item.value)}</text>
  </g>`;
    })
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="8" fill="${THEME.bg}" stroke="${THEME.border}" stroke-width="1"/>
  <text x="20" y="28" fill="${THEME.title}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="14" font-weight="600">GitHub Trophies</text>
  ${cells}
</svg>`;
}

function generateContributionGridSnakeSvg(days, { dark = false } = {}) {
  const width = 900;
  const height = 180;
  const cell = 11;
  const gap = 3;
  const offsetX = 20;
  const offsetY = 36;

  const palette = dark
    ? ["#161b22", "#2e1065", "#5b21b6", "#7c3aed", "#a78bfa"]
    : ["#e9d5ff", "#ddd6fe", "#c4b5fd", "#a78bfa", "#7c3aed"];
  const bg = dark ? "#0b0b10" : "#faf5ff";
  const border = dark ? "#312e81" : "#c4b5fd";
  const title = dark ? "#c4b5fd" : "#5b21b6";

  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const origin = new Date(sorted[0]?.date || Date.now());
  const cells = sorted.map((day) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    const dayOffset = Math.round((date.getTime() - origin.getTime()) / 86400000);
    const level = Math.min(4, Math.max(0, day.contributionCount === 0 ? 0 : Math.ceil(day.contributionCount / 2)));
    return {
      x: Math.floor(dayOffset / 7),
      y: date.getUTCDay(),
      color: palette[level],
    };
  });

  const rects = cells
    .map(({ x, y, color }) => {
      const rx = offsetX + x * (cell + gap);
      const ry = offsetY + y * (cell + gap);
      return `<rect x="${rx}" y="${ry}" width="${cell}" height="${cell}" rx="2" fill="${color}"/>`;
    })
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="8" fill="${bg}" stroke="${border}" stroke-width="1"/>
  <text x="20" y="24" fill="${title}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="14" font-weight="600">Contribution Grid</text>
  ${rects}
</svg>`;
}
  const width = 900;
  const height = 200;
  const padding = { left: 48, right: 24, top: 42, bottom: 28 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const recent = sorted.slice(-52);
  const maxCount = Math.max(1, ...recent.map((d) => d.contributionCount));
  const step = chartW / Math.max(1, recent.length - 1);

  const points = recent.map((day, index) => {
    const x = padding.left + index * step;
    const y = padding.top + chartH - (day.contributionCount / maxCount) * chartH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const areaPath = `M ${padding.left},${padding.top + chartH} L ${points.join(" L ")} L ${padding.left + (recent.length - 1) * step},${padding.top + chartH} Z`;
  const linePath = `M ${points.join(" L ")}`;

  const bars = recent
    .map((day, index) => {
      if (day.contributionCount === 0) return "";
      const x = padding.left + index * step - 3;
      const barH = (day.contributionCount / maxCount) * chartH;
      const y = padding.top + chartH - barH;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="6" height="${barH.toFixed(1)}" rx="2" fill="${THEME.accent3}" opacity="0.45"/>`;
    })
    .join("\n  ");

  const monthLabels = [];
  let lastMonth = "";
  recent.forEach((day, index) => {
    const month = day.date.slice(5, 7);
    if (month !== lastMonth) {
      lastMonth = month;
      const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      monthLabels.push(
        `<text x="${(padding.left + index * step).toFixed(1)}" y="${height - 8}" fill="${THEME.muted}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="10">${names[Number(month) - 1]}</text>`,
      );
    }
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="8" fill="${THEME.bg}" stroke="${THEME.border}" stroke-width="1"/>
  <text x="20" y="26" fill="${THEME.title}" font-family="Segoe UI, Ubuntu, sans-serif" font-size="14" font-weight="600">Contribution Activity (last 52 weeks)</text>
  <line x1="${padding.left}" y1="${padding.top + chartH}" x2="${width - padding.right}" y2="${padding.top + chartH}" stroke="${THEME.border}" stroke-width="1"/>
  <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartH}" stroke="${THEME.border}" stroke-width="1"/>
  ${bars}
  <path d="${areaPath}" fill="${THEME.graphFill}"/>
  <path d="${linePath}" fill="none" stroke="${THEME.graphStroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  ${monthLabels.join("\n  ")}
</svg>`;
}

async function main() {
  if (!TOKEN) {
    console.warn("Warning: GITHUB_TOKEN not set. GraphQL requests may fail.");
  }

  await mkdir(OUT_DIR, { recursive: true });

  const user = await fetchUser();
  const repos = await fetchRepos();
  const contributionData = await fetchContributionData(user, repos);

  const languages = await fetchLanguageTotals(repos);
  const streak = calculateStreaks(contributionData.days);

  const files = {
    "stats.svg": generateStatsSvg(user, contributionData),
    "top-langs.svg": generateTopLangsSvg(languages),
    "streak.svg": generateStreakSvg(streak, contributionData.displayName),
    "trophies.svg": generateTrophiesSvg({
      totalStars: contributionData.totalStars,
      totalCommitContributions: contributionData.totalCommitContributions,
      publicRepos: user.public_repos,
      followers: user.followers,
      totalIssueContributions: contributionData.totalIssueContributions,
      totalPullRequestContributions: contributionData.totalPullRequestContributions,
    }),
    "activity.svg": generateActivitySvg(contributionData.days),
    "github-contribution-grid-snake.svg": generateContributionGridSnakeSvg(contributionData.days, { dark: false }),
    "github-contribution-grid-snake-dark.svg": generateContributionGridSnakeSvg(contributionData.days, { dark: true }),
  };

  for (const [name, svg] of Object.entries(files)) {
    if (!svg.includes("<svg")) {
      throw new Error(`Invalid SVG generated for ${name}`);
    }
    const target = join(OUT_DIR, name);
    await writeFile(target, svg, "utf8");
    console.log(`Wrote ${target}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
