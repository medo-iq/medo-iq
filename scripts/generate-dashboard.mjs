import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const DEFAULT_USERNAME = "medo-iq";
const OUTPUT_DIRECTORY = resolve("dist");
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 600;

const THEMES = {
  light: {
    background: "#ffffff",
    surface: "#f6f8fa",
    surfaceSubtle: "#eef1f4",
    border: "#d0d7de",
    textPrimary: "#1f2328",
    textSecondary: "#59636e",
    textMuted: "#818b98",
    accent: "#0969da",
    contribution0: "#ebedf0",
    contribution1: "#9be9a8",
    contribution2: "#40c463",
    contribution3: "#30a14e",
    contribution4: "#216e39",
    snake: "#0969da",
    snakeHead: "#0550ae",
    languageFallback: "#8c959f"
  },
  dark: {
    background: "#0d1117",
    surface: "#161b22",
    surfaceSubtle: "#21262d",
    border: "#30363d",
    textPrimary: "#f0f6fc",
    textSecondary: "#8b949e",
    textMuted: "#6e7681",
    accent: "#58a6ff",
    contribution0: "#161b22",
    contribution1: "#0e4429",
    contribution2: "#006d32",
    contribution3: "#26a641",
    contribution4: "#39d353",
    snake: "#58a6ff",
    snakeHead: "#79c0ff",
    languageFallback: "#8b949e"
  }
};

const CONTRIBUTION_QUERY = `
  query ProfileContributions($login: String!) {
    user(login: $login) {
      name
      login
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
              contributionLevel
              weekday
            }
          }
        }
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
      }
    }
  }
`;

const REPOSITORIES_QUERY = `
  query PublicRepositories($login: String!, $after: String) {
    user(login: $login) {
      repositories(
        first: 100
        after: $after
        ownerAffiliations: OWNER
        privacy: PUBLIC
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          name
          isFork
          visibility
          stargazerCount
          languages(first: 100, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
    }
  }
`;

function requireToken() {
  const token = process.env.GITHUB_TOKEN?.trim();

  if (!token) {
    throw new Error(
      'Missing GITHUB_TOKEN.\nRun:\nGITHUB_TOKEN="$(gh auth token)" npm run generate:dashboard'
    );
  }

  return token;
}

async function requestGraphQL(token, query, variables) {
  let response;

  try {
    response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "medo-iq-profile-dashboard",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify({ query, variables })
    });
  } catch (error) {
    throw new Error(`Unable to reach the GitHub API: ${error.message}`);
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error(
      `GitHub API returned an unreadable response (HTTP ${response.status}).`
    );
  }

  if (!response.ok) {
    throw new Error(
      `GitHub API request failed (HTTP ${response.status} ${response.statusText}).`
    );
  }

  if (payload.errors?.length) {
    const messages = payload.errors
      .map((error) => error.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(`GitHub GraphQL error: ${messages || "Unknown error"}`);
  }

  if (!payload.data) {
    throw new Error("GitHub GraphQL response did not contain data.");
  }

  return payload.data;
}

async function fetchGitHubData(token, username) {
  const data = await requestGraphQL(token, CONTRIBUTION_QUERY, {
    login: username
  });

  if (!data.user) {
    throw new Error(`GitHub user "${username}" was not found.`);
  }

  const contributions = data.user.contributionsCollection;
  const calendar = contributions?.contributionCalendar;

  if (!contributions || !calendar || !Array.isArray(calendar.weeks)) {
    throw new Error(
      `Contribution data is unavailable for GitHub user "${username}".`
    );
  }

  return {
    name: data.user.name || "Ahmed Majid",
    login: data.user.login,
    calendar,
    totals: {
      contributions: calendar.totalContributions,
      commits: contributions.totalCommitContributions,
      issues: contributions.totalIssueContributions,
      pullRequests: contributions.totalPullRequestContributions,
      reviews: contributions.totalPullRequestReviewContributions
    }
  };
}

async function fetchRepositories(token, username) {
  const repositories = [];
  let after = null;
  let pageCount = 0;

  do {
    const data = await requestGraphQL(token, REPOSITORIES_QUERY, {
      login: username,
      after
    });

    if (!data.user) {
      throw new Error(`GitHub user "${username}" was not found.`);
    }

    const connection = data.user.repositories;

    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error("Repository data is missing from the GitHub response.");
    }

    repositories.push(...connection.nodes.filter(Boolean));
    pageCount += 1;

    if (pageCount > 50) {
      throw new Error("Repository pagination exceeded the safety limit.");
    }

    if (!connection.pageInfo.hasNextPage) {
      break;
    }

    after = connection.pageInfo.endCursor;

    if (!after) {
      throw new Error(
        "GitHub reported another repository page without an end cursor."
      );
    }
  } while (after);

  return repositories;
}

function aggregateLanguages(repositories) {
  const languageTotals = new Map();
  let totalBytes = 0;

  for (const repository of repositories) {
    if (repository.isFork || repository.visibility !== "PUBLIC") {
      continue;
    }

    for (const edge of repository.languages?.edges || []) {
      const name = edge?.node?.name;
      const size = Number(edge?.size || 0);

      if (!name || !Number.isFinite(size) || size <= 0) {
        continue;
      }

      const current = languageTotals.get(name) || {
        name,
        bytes: 0,
        color: edge.node.color || null
      };

      current.bytes += size;
      current.color ||= edge.node.color || null;
      languageTotals.set(name, current);
      totalBytes += size;
    }
  }

  if (totalBytes === 0) {
    return [];
  }

  const ranked = [...languageTotals.values()]
    .map((language) => ({
      ...language,
      percentage: (language.bytes / totalBytes) * 100
    }))
    .sort((left, right) => right.bytes - left.bytes);

  const meaningful = ranked.filter((language) => language.percentage >= 1);
  return (meaningful.length > 0 ? meaningful : ranked).slice(0, 5);
}

function summarizeRepositories(repositories) {
  const ownedPublic = repositories.filter(
    (repository) =>
      repository.visibility === "PUBLIC" && repository.isFork === false
  );

  return {
    count: ownedPublic.length,
    stars: ownedPublic.reduce(
      (sum, repository) => sum + Number(repository.stargazerCount || 0),
      0
    )
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeColor(value, fallback) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : fallback;
}

function formatNumber(value) {
  const number = Number(value || 0);

  if (number < 1000) {
    return String(number);
  }

  const units = [
    { threshold: 1_000_000_000, suffix: "b" },
    { threshold: 1_000_000, suffix: "m" },
    { threshold: 1_000, suffix: "k" }
  ];

  const unit = units.find((candidate) => number >= candidate.threshold);
  const scaled = number / unit.threshold;
  const precision = scaled >= 10 ? 0 : 1;

  return `${scaled.toFixed(precision).replace(/\.0$/, "")}${unit.suffix}`;
}

function formatPercentage(value) {
  return `${Number(value).toFixed(1)}%`;
}

function formatUpdatedDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  })
    .format(date)
    .replace(",", "");
}

function contributionColor(level, theme) {
  const colors = {
    NONE: theme.contribution0,
    FIRST_QUARTILE: theme.contribution1,
    SECOND_QUARTILE: theme.contribution2,
    THIRD_QUARTILE: theme.contribution3,
    FOURTH_QUARTILE: theme.contribution4
  };

  return colors[level] || theme.contribution0;
}

function roundCoordinate(value) {
  return Number(value.toFixed(2));
}

function distanceBetween(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function pointAlongLine(from, to, distance) {
  const length = distanceBetween(from, to);

  if (length === 0) {
    return { ...from };
  }

  const ratio = distance / length;

  return {
    x: roundCoordinate(from.x + (to.x - from.x) * ratio),
    y: roundCoordinate(from.y + (to.y - from.y) * ratio)
  };
}

function createRoundedClosedPath(points, cornerRadius) {
  if (points.length < 3) {
    return "";
  }

  const corners = points.map((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const radius = Math.min(
      cornerRadius,
      distanceBetween(previous, point) / 2,
      distanceBetween(point, next) / 2
    );

    return {
      point,
      entry: pointAlongLine(point, previous, radius),
      exit: pointAlongLine(point, next, radius)
    };
  });

  const commands = [`M ${corners[0].entry.x} ${corners[0].entry.y}`];

  corners.forEach((corner, index) => {
    const nextCorner = corners[(index + 1) % corners.length];
    commands.push(
      `Q ${corner.point.x} ${corner.point.y} ${corner.exit.x} ${corner.exit.y}`,
      `L ${nextCorner.entry.x} ${nextCorner.entry.y}`
    );
  });

  commands.push("Z");
  return commands.join(" ");
}

function buildContributionGrid(calendar, theme) {
  const weeks = calendar.weeks;
  const cellSize = 14;
  const gap = 4;
  const step = cellSize + gap;
  const gridWidth =
    weeks.length > 0 ? weeks.length * cellSize + (weeks.length - 1) * gap : 0;
  const startX = roundCoordinate((CANVAS_WIDTH - gridWidth) / 2);
  const startY = 370;
  const cells = [];
  const pointsByRow = Array.from({ length: 7 }, () => []);

  weeks.forEach((week, weekIndex) => {
    for (const day of week.contributionDays || []) {
      const weekday = Number(day.weekday);

      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        continue;
      }

      const x = roundCoordinate(startX + weekIndex * step);
      const y = roundCoordinate(startY + weekday * step);
      const center = {
        x: roundCoordinate(x + cellSize / 2),
        y: roundCoordinate(y + cellSize / 2)
      };

      pointsByRow[weekday].push(center);
      cells.push(
        `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="3" fill="${contributionColor(day.contributionLevel, theme)}" />`
      );
    }
  });

  const monthCandidates = [];

  weeks.forEach((week, weekIndex) => {
    const firstOfMonth = (week.contributionDays || []).find((day) => {
      const date = new Date(`${day.date}T00:00:00Z`);
      return date.getUTCDate() === 1;
    });

    if (!firstOfMonth) {
      return;
    }

    const date = new Date(`${firstOfMonth.date}T00:00:00Z`);
    monthCandidates.push({
      label: new Intl.DateTimeFormat("en-US", {
        month: "short",
        timeZone: "UTC"
      }).format(date),
      x: roundCoordinate(startX + weekIndex * step)
    });
  });

  let lastMonthX = Number.NEGATIVE_INFINITY;
  const monthLabels = monthCandidates
    .filter((month) => {
      if (month.x - lastMonthX < 38) {
        return false;
      }

      lastMonthX = month.x;
      return true;
    })
    .map(
      (month) =>
        `<text x="${month.x}" y="355" class="month-label">${escapeXml(month.label)}</text>`
    );

  const weekdayLabels = [
    { label: "Mon", row: 1 },
    { label: "Wed", row: 3 },
    { label: "Fri", row: 5 }
  ].map(
    ({ label, row }) =>
      `<text x="${roundCoordinate(startX - 12)}" y="${roundCoordinate(startY + row * step + 11)}" text-anchor="end" class="weekday-label">${label}</text>`
  );

  return {
    cells,
    monthLabels,
    weekdayLabels,
    pointsByRow,
    startX,
    gridWidth,
    cellSize,
    gap,
    step
  };
}

function createSnakePath(pointsByRow) {
  const routePoints = [];

  pointsByRow.forEach((rowPoints, rowIndex) => {
    const ordered =
      rowIndex % 2 === 0 ? [...rowPoints] : [...rowPoints].reverse();

    if (ordered.length === 0) {
      return;
    }

    routePoints.push(ordered[0]);

    if (ordered.length > 1) {
      routePoints.push(ordered.at(-1));
    }
  });

  if (routePoints.length < 2) {
    return null;
  }

  const origin = routePoints[0];
  const end = routePoints.at(-1);
  const lowestPoint = Math.max(
    ...pointsByRow.flat().map((point) => point.y)
  );
  const returnY = roundCoordinate(lowestPoint + 24);
  const loopPoints = [
    ...routePoints,
    { x: end.x, y: returnY },
    { x: origin.x, y: returnY }
  ];
  const relativeLoopPoints = loopPoints.map((point) => ({
    x: roundCoordinate(point.x - origin.x),
    y: roundCoordinate(point.y - origin.y)
  }));

  return {
    path: createRoundedClosedPath(loopPoints, 9),
    motionPath: createRoundedClosedPath(relativeLoopPoints, 9),
    origin
  };
}

function renderStats(stats, theme) {
  const metrics = [
    ["Contributions", stats.contributions],
    ["Commits", stats.commits],
    ["Pull requests", stats.pullRequests],
    ["Repositories", stats.repositories],
    ["Stars", stats.stars]
  ];
  const startX = 60;
  const availableWidth = 500;
  const columnWidth = availableWidth / metrics.length;

  return metrics
    .map(([label, value], index) => {
      const x = roundCoordinate(startX + index * columnWidth);
      return `
        <g>
          <text x="${x}" y="192" class="metric-value">${escapeXml(formatNumber(value))}</text>
          <text x="${x}" y="218" class="metric-label">${escapeXml(label.toUpperCase())}</text>
        </g>
      `;
    })
    .join("");
}

function renderLanguages(languages, theme) {
  const barX = 790;
  const barWidth = 280;

  if (languages.length === 0) {
    return `
      <text x="640" y="190" class="empty-state">No public language data available</text>
    `;
  }

  return languages
    .map((language, index) => {
      const y = 164 + index * 23;
      const fillWidth = Math.max(
        3,
        roundCoordinate((barWidth * language.percentage) / 100)
      );
      const color = normalizeColor(language.color, theme.languageFallback);

      return `
        <g>
          <circle cx="642" cy="${y - 4}" r="4" fill="${escapeXml(color)}" />
          <text x="655" y="${y}" class="language-name">${escapeXml(language.name)}</text>
          <rect x="${barX}" y="${y - 10}" width="${barWidth}" height="8" rx="4" fill="${theme.surfaceSubtle}" />
          <rect x="${barX}" y="${y - 10}" width="${fillWidth}" height="8" rx="4" fill="${escapeXml(color)}" />
          <text x="1138" y="${y}" text-anchor="end" class="language-percent">${escapeXml(formatPercentage(language.percentage))}</text>
        </g>
      `;
    })
    .join("");
}

function renderLegend(grid, theme) {
  const legendY = 538;
  const squareSize = 11;
  const legendGap = 4;
  const levels = [
    theme.contribution0,
    theme.contribution1,
    theme.contribution2,
    theme.contribution3,
    theme.contribution4
  ];
  const startX = grid.startX;

  const squares = levels
    .map(
      (color, index) =>
        `<rect x="${roundCoordinate(startX + 29 + index * (squareSize + legendGap))}" y="${legendY - 10}" width="${squareSize}" height="${squareSize}" rx="2" fill="${color}" />`
    )
    .join("");

  return `
    <text x="${startX}" y="${legendY}" class="legend-label">Less</text>
    ${squares}
    <text x="${roundCoordinate(startX + 29 + levels.length * (squareSize + legendGap) + 2)}" y="${legendY}" class="legend-label">More</text>
  `;
}

function renderSnake(snake, theme) {
  if (!snake) {
    return "";
  }

  return `
    <defs>
      <path id="snake-motion-route" d="${snake.motionPath}" fill="none" />
      <linearGradient id="snake-trail-gradient" x1="-54" y1="0" x2="0" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${theme.snake}" stop-opacity="0" />
        <stop offset="0.45" stop-color="${theme.snake}" stop-opacity="0.42" />
        <stop offset="1" stop-color="${theme.snake}" stop-opacity="0.94" />
      </linearGradient>
    </defs>
    <path
      d="${snake.path}"
      fill="none"
      stroke="${theme.snake}"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
      opacity="0.08"
      aria-hidden="true"
    />
    <g transform="translate(${snake.origin.x} ${snake.origin.y})" aria-hidden="true">
      <g class="snake-motion">
        <line
          x1="-54"
          y1="0"
          x2="0"
          y2="0"
          stroke="url(#snake-trail-gradient)"
          stroke-width="6"
          stroke-linecap="round"
        />
        <circle
          cx="0"
          cy="0"
          r="5"
          fill="${theme.snakeHead}"
          stroke="${theme.background}"
          stroke-width="2"
        />
        <animateMotion
          begin="0s"
          dur="20s"
          repeatCount="indefinite"
          rotate="auto"
          calcMode="linear"
        >
          <mpath href="#snake-motion-route" />
        </animateMotion>
      </g>
    </g>
  `;
}

function renderTheme({
  themeName,
  profile,
  stats,
  languages,
  generatedAt
}) {
  const theme = THEMES[themeName];
  const grid = buildContributionGrid(profile.calendar, theme);
  const snake = createSnakePath(grid.pointsByRow);
  const displayName = escapeXml(profile.name);
  const login = escapeXml(profile.login);
  const updated = escapeXml(formatUpdatedDate(generatedAt));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}" viewBox="0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="dashboard-title dashboard-description">
  <title id="dashboard-title">Ahmed Majid GitHub Activity Dashboard</title>
  <desc id="dashboard-description">GitHub statistics, top programming languages, and contribution activity for medo-iq.</desc>
  <style>
    text {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    }
    .eyebrow {
      fill: ${theme.textMuted};
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 1.5px;
    }
    .profile-name {
      fill: ${theme.textPrimary};
      font-size: 25px;
      font-weight: 650;
    }
    .profile-handle,
    .updated,
    .metric-label,
    .language-percent,
    .month-label,
    .weekday-label,
    .legend-label,
    .empty-state {
      fill: ${theme.textMuted};
    }
    .profile-handle {
      font-size: 13px;
    }
    .updated {
      font-size: 12px;
    }
    .metric-value {
      fill: ${theme.textPrimary};
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 25px;
      font-weight: 650;
    }
    .metric-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.55px;
    }
    .language-name {
      fill: ${theme.textSecondary};
      font-size: 12px;
      font-weight: 550;
    }
    .language-percent {
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 11px;
    }
    .month-label,
    .weekday-label,
    .legend-label {
      font-size: 11px;
    }
    .empty-state {
      font-size: 13px;
    }
    @media (prefers-reduced-motion: reduce) {
      .snake-motion {
        display: none;
      }
    }
  </style>

  <rect x="1" y="1" width="1198" height="598" rx="16" fill="${theme.background}" stroke="${theme.border}" />

  <g>
    <text x="40" y="40" class="profile-name">${displayName}</text>
    <text x="40" y="64" class="profile-handle">@${login}</text>
    <text x="1160" y="37" text-anchor="end" class="eyebrow">GITHUB ACTIVITY</text>
    <text x="1160" y="62" text-anchor="end" class="updated">Updated ${updated} · UTC</text>
  </g>

  <line x1="32" y1="88" x2="1168" y2="88" stroke="${theme.border}" />

  <rect x="32" y="108" width="554" height="164" rx="10" fill="${theme.surface}" stroke="${theme.border}" />
  <text x="52" y="137" class="eyebrow">GITHUB STATISTICS</text>
  ${renderStats(stats, theme)}

  <rect x="610" y="108" width="558" height="164" rx="10" fill="${theme.surface}" stroke="${theme.border}" />
  <text x="632" y="137" class="eyebrow">TOP LANGUAGES</text>
  ${renderLanguages(languages, theme)}

  <line x1="32" y1="292" x2="1168" y2="292" stroke="${theme.border}" />
  <text x="40" y="326" class="eyebrow">CONTRIBUTION ACTIVITY</text>
  <text x="1160" y="326" text-anchor="end" class="updated">${escapeXml(formatNumber(stats.contributions))} contributions in the past year</text>

  ${grid.monthLabels.join("")}
  ${grid.weekdayLabels.join("")}
  ${grid.cells.join("")}
  ${renderSnake(snake, theme)}
  ${renderLegend(grid, theme)}
  <text x="${roundCoordinate(grid.startX + grid.gridWidth)}" y="538" text-anchor="end" class="legend-label">Calendar data provided by GitHub</text>
</svg>
`;
}

async function writeDashboardFiles(data) {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });

  await Promise.all([
    writeFile(
      resolve(OUTPUT_DIRECTORY, "github-dashboard-light.svg"),
      renderTheme({ ...data, themeName: "light" }),
      "utf8"
    ),
    writeFile(
      resolve(OUTPUT_DIRECTORY, "github-dashboard-dark.svg"),
      renderTheme({ ...data, themeName: "dark" }),
      "utf8"
    )
  ]);
}

async function main() {
  const token = requireToken();
  const username = process.env.GITHUB_USERNAME?.trim() || DEFAULT_USERNAME;
  const [profile, repositories] = await Promise.all([
    fetchGitHubData(token, username),
    fetchRepositories(token, username)
  ]);
  const repositorySummary = summarizeRepositories(repositories);
  const languages = aggregateLanguages(repositories);
  const stats = {
    contributions: profile.totals.contributions,
    commits: profile.totals.commits,
    pullRequests: profile.totals.pullRequests,
    repositories: repositorySummary.count,
    stars: repositorySummary.stars
  };

  await writeDashboardFiles({
    profile,
    stats,
    languages,
    generatedAt: new Date()
  });

  console.log(`Username: ${profile.login}`);
  console.log(`Contributions: ${stats.contributions}`);
  console.log(`Commits: ${stats.commits}`);
  console.log(`Pull requests: ${stats.pullRequests}`);
  console.log(`Public non-fork repositories: ${stats.repositories}`);
  console.log(`Stars: ${stats.stars}`);
  console.log(
    `Languages rendered: ${languages.map((language) => language.name).join(", ") || "None"}`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
