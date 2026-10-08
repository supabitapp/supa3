import { useAtomValue } from "@effect/atom-react";
import {
  getProviderSkillsForSlashMenu,
  resolveProviderSkillsForCwd,
} from "@supacode/client-runtime/providerSkills";
import {
  AuthOrchestrationOperateScope,
  type KeybindingCommand,
  type ScheduledTaskId,
  type ServerProvider,
} from "@supacode/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@supacode/client-runtime/state/runtime";
import { formatDayShort, formatTokens, formatUsd, makeWindow } from "@supacode/shared/usageFormat";
import { providersWithLimits } from "@supacode/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, FileDiffIcon, PaperclipIcon, PlayIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useNowMinuteMs } from "../../../hooks/useNowMinute";
import { nextRunLabel, scheduleLabel } from "../../../components/automations/automations.logic";
import { ProviderInstanceIcon } from "../../../components/chat/ProviderInstanceIcon";
import { EnvironmentMachineIcon } from "../../../components/EnvironmentMachineIcon";
import { isProviderUpdateCandidate } from "../../../components/ProviderUpdateLaunchNotification.logic";
import { environmentTransportLabel } from "../../../components/settings/EnvironmentRow";
import { Kbd } from "../../../components/ui/kbd";
import { stackedThreadToast, toastManager } from "../../../components/ui/toast";
import { LimitWindows } from "../../../components/usage/UsageLimits";
import { PROVIDER_PRESENTATION } from "../../../components/usage/usageProviders";
import { shortcutLabelForCommand } from "../../../keybindings";
import { cn } from "../../../lib/utils";
import { usePromptStashStore } from "../../../promptStashStore";
import {
  useEnvironment,
  useEnvironmentMachines,
  useEnvironments,
} from "../../../state/environments";
import { useEnvironmentQuery } from "../../../state/query";
import { useEnvironmentScope } from "../../../state/session";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../../state/server";
import { useUsage } from "../../../state/usage";
import { useAtomCommand } from "../../../state/use-atom-command";
import { vcsEnvironment } from "../../../state/vcs";
import { ago } from "../data";
import { More, Row, Time, writeToComposer } from "./bodies";
import { rowsThatFit, useWidgetEnv, useWidgetFrame } from "./context";
import { StatSkeleton, WidgetEmpty, WidgetSkeleton } from "./scenes";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

const SHORTCUTS: ReadonlyArray<{ command: KeybindingCommand; label: string; tip: string }> = [
  {
    command: "composer.sendBackground",
    label: "Send in the background",
    tip: "Send a prompt and stay where you are.",
  },
  {
    command: "composer.sendAndNewThread",
    label: "Send and start another",
    tip: "Fire off a task and land on a fresh draft.",
  },
  {
    command: "composer.stash",
    label: "Stash the prompt",
    tip: "Park a half-written prompt and get it back later.",
  },
  {
    command: "thread.fork",
    label: "Fork the thread",
    tip: "Try a different direction without losing this one.",
  },
  {
    command: "thread.settle",
    label: "Settle the thread",
    tip: "Move a finished thread out of your way.",
  },
  {
    command: "thread.pin",
    label: "Pin the thread",
    tip: "Keep a thread at the top of the sidebar.",
  },
  { command: "thread.next", label: "Next thread", tip: "Walk your threads without the mouse." },
  {
    command: "diff.toggle",
    label: "Show changes",
    tip: "See what the agent changed in this thread.",
  },
  { command: "preview.toggle", label: "Toggle preview", tip: "Open the browser next to the chat." },
  {
    command: "terminal.toggle",
    label: "Toggle terminal",
    tip: "A terminal in the thread's worktree.",
  },
  {
    command: "view.reopenClosed",
    label: "Reopen closed view",
    tip: "Bring back the panel you just closed.",
  },
  { command: "usage.open", label: "Open usage", tip: "Check your limits before a long run." },
];

export function ShortcutsBody() {
  const { size, bodyHeight } = useWidgetFrame();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const now = useNowMinuteMs();
  const bound = SHORTCUTS.flatMap((s) => {
    const label = shortcutLabelForCommand(keybindings, s.command);
    return label ? [{ ...s, keys: label }] : [];
  });
  if (bound.length === 0) return null;

  if (size === "s") {
    const tip = bound[Math.floor(now / 86_400_000) % bound.length]!;
    return (
      <div className="flex h-full flex-col justify-center gap-2 px-3">
        <Kbd className="self-start">{tip.keys}</Kbd>
        <p className="text-sm font-medium text-foreground">{tip.label}</p>
        <p className="text-xs text-muted-foreground">{tip.tip}</p>
      </div>
    );
  }

  const rows = Math.max(1, Math.floor((bodyHeight - 4) / 30));
  const columns = size === "w" || size === "l" ? 2 : 1;
  return (
    <ul className={columns === 2 ? "grid grid-cols-2 gap-x-4 px-2" : "flex flex-col px-2"}>
      {bound.slice(0, rows * columns).map((s) => (
        <li key={s.command} className="flex h-7.5 items-center gap-3 text-sm">
          <span className="min-w-0 flex-1 truncate text-foreground">{s.label}</span>
          <Kbd>{s.keys}</Kbd>
        </li>
      ))}
    </ul>
  );
}

function ProviderMark({ provider }: { provider: ServerProvider }) {
  return (
    <ProviderInstanceIcon
      driverKind={provider.driver}
      displayName={provider.displayName ?? provider.driver}
      accentColor={provider.accentColor}
      className="size-4 shrink-0"
    />
  );
}

export function UsageLimitsBody() {
  const { environments } = useEnvironments();
  const now = useNowMinuteMs();
  const rows = environments.flatMap((env) =>
    providersWithLimits(env.serverConfig?.providers ?? EMPTY_PROVIDERS).map((provider) => ({
      env,
      provider,
    })),
  );
  if (rows.length === 0) {
    return (
      <WidgetEmpty
        scene="horizon"
        title="No plan limits reported"
        hint="Providers that report session and weekly limits show them here."
      />
    );
  }
  const multipleMachines = new Set(rows.map((r) => r.env.environmentId)).size > 1;
  return (
    <div className="flex flex-col gap-3 overflow-y-auto px-2 pt-0.5 pb-1">
      {rows.map(({ env, provider }) => (
        <div key={`${env.environmentId}:${provider.instanceId}`} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-xs">
            <ProviderMark provider={provider} />
            <span className="font-medium text-foreground">
              {provider.displayName ?? provider.driver}
            </span>
            {multipleMachines ? (
              <span className="truncate text-muted-foreground">{env.label}</span>
            ) : null}
          </div>
          <LimitWindows
            driver={provider.driver}
            windows={provider.usageLimits?.windows ?? []}
            now={now}
            compact
          />
        </div>
      ))}
    </div>
  );
}

const PHASE_TONE: Record<string, { dot: string; label: string }> = {
  connected: { dot: "bg-success", label: "Connected" },
  connecting: { dot: "bg-info", label: "Connecting" },
  reconnecting: { dot: "bg-info", label: "Reconnecting" },
  available: { dot: "bg-muted-foreground/50", label: "Available" },
  offline: { dot: "bg-muted-foreground/50", label: "Offline" },
  error: { dot: "bg-error", label: "Error" },
  unsupported: { dot: "bg-warning", label: "Unsupported" },
};

export function MachinesBody() {
  const { environments } = useEnvironments();
  const machines = useEnvironmentMachines();
  const { bodyHeight, size } = useWidgetFrame();
  const visible = environments.filter((env) => env.entry.enabled);
  if (visible.length === 0) {
    return (
      <WidgetEmpty
        scene="dock"
        title="No machines"
        hint="Connect a machine in Settings → Connections."
      />
    );
  }
  const shown = visible.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((env) => {
        const tone = PHASE_TONE[env.connection.phase] ?? PHASE_TONE.offline!;
        const version = env.serverConfig?.environment.serverVersion ?? null;
        return (
          <Row key={env.environmentId}>
            <EnvironmentMachineIcon
              kind={machines.get(env.environmentId) ?? "desktop"}
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate text-foreground">{env.label}</span>
            {size === "s" ? null : (
              <span className="max-w-[9rem] shrink-0 truncate text-xs text-muted-foreground">
                {environmentTransportLabel(env)}
              </span>
            )}
            {version && size !== "s" ? (
              <span className="shrink-0 font-mono text-2xs text-secondary-label">v{version}</span>
            ) : null}
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
            <span className="sr-only">{tone.label}</span>
          </Row>
        );
      })}
      <More n={visible.length - shown.length} label="machines" />
    </div>
  );
}

function providerState(provider: ServerProvider): { label: string; tone: string; rank: number } {
  if (!provider.installed)
    return { label: "Not installed", tone: "text-muted-foreground", rank: 3 };
  if (provider.status === "error")
    return { label: provider.message ?? "Error", tone: "text-error", rank: 0 };
  if (provider.auth.status === "unauthenticated")
    return { label: "Sign in needed", tone: "text-warning-foreground", rank: 1 };
  if (isProviderUpdateCandidate(provider)) {
    return {
      label: `Update to ${provider.versionAdvisory?.latestVersion}`,
      tone: "text-info",
      rank: 2,
    };
  }
  if (provider.status === "warning")
    return { label: provider.message ?? "Warning", tone: "text-warning-foreground", rank: 1 };
  return {
    label: provider.version ? `Ready · v${provider.version}` : "Ready",
    tone: "text-secondary-label",
    rank: 4,
  };
}

export function ProvidersBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight } = useWidgetFrame();
  const environmentId = data.project?.environmentId ?? null;
  const providers = useEnvironment(environmentId)?.serverConfig?.providers ?? EMPTY_PROVIDERS;
  const rows = providers
    .filter((p) => p.enabled)
    .map((provider) => ({ provider, state: providerState(provider) }))
    .sort((a, b) => a.state.rank - b.state.rank);
  if (environmentId === null || rows.length === 0) {
    return (
      <WidgetEmpty
        scene="anchor"
        title="No providers"
        hint="Turn on a provider in Settings → Providers."
      />
    );
  }
  const shown = rows.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map(({ provider, state }) => (
        <Row key={provider.instanceId}>
          <ProviderMark provider={provider} />
          <span className="max-w-[50%] shrink-0 truncate text-foreground">
            {provider.displayName ?? provider.driver}
          </span>
          <span className={cn("min-w-0 flex-1 truncate text-right text-xs", state.tone)}>
            {state.label}
          </span>
        </Row>
      ))}
      <More n={rows.length - shown.length} label="providers" />
    </div>
  );
}

export function AutomationsBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight, preview } = useWidgetFrame();
  const now = useNowMinuteMs();
  const navigate = useNavigate();
  const environmentId = data.project?.environmentId ?? null;
  const tasksQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const run = async (taskId: ScheduledTaskId) => {
    if (environmentId === null || !canOperate) return;
    setStarted(taskId);
    const result = await runNow({ environmentId, input: { id: taskId } });
    setStarted(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't run the automation",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  const [started, setStarted] = useState<string | null>(null);
  const tasks = [...(tasksQuery.data?.tasks ?? [])]
    .filter((task) => task.enabled)
    .sort((a, b) => Date.parse(a.nextRunAt ?? "9999") - Date.parse(b.nextRunAt ?? "9999"));
  if (tasksQuery.error) {
    return <WidgetEmpty scene="chart" title="Couldn't load automations" hint={tasksQuery.error} />;
  }
  if (tasksQuery.data === null) {
    return <WidgetSkeleton rows={2} label="Loading automations" />;
  }
  if (tasks.length === 0) {
    return (
      <WidgetEmpty
        scene="chart"
        title="No automations"
        hint="Prompts that run on a schedule show up here, with when they run next."
        action={{ label: "Set one up", onClick: () => void navigate({ to: "/automations" }) }}
      />
    );
  }
  const shown = tasks.slice(0, Math.max(1, Math.floor((bodyHeight - 18) / 44)));
  return (
    <div className="flex flex-col">
      {shown.map((task) => (
        <div
          key={task.id}
          className="group/row flex h-11 items-center gap-2 rounded-lg px-2 hover:bg-accent"
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              task.lastRunStatus === "failed"
                ? "bg-error"
                : task.lastRunStatus === "running"
                  ? "bg-info"
                  : "bg-success",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-foreground">{task.title}</span>
            <span className="truncate text-xs text-muted-foreground">
              {scheduleLabel(task.schedule)} · {nextRunLabel(task, now)}
            </span>
          </span>
          {canOperate ? (
            <button
              type="button"
              aria-label={`Run ${task.title} now`}
              tabIndex={preview ? -1 : undefined}
              disabled={started === task.id}
              onClick={() => void run(task.id)}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:opacity-100"
            >
              <PlayIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      ))}
      <More n={tasks.length - shown.length} label="scheduled" />
    </div>
  );
}

export function StashBody() {
  const { composerRef } = useWidgetEnv();
  const { bodyHeight } = useWidgetFrame();
  const now = useNowMinuteMs();
  const entries = usePromptStashStore((s) => s.entries);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (entries.length === 0) {
    const keys = shortcutLabelForCommand(keybindings, "composer.stash");
    return (
      <WidgetEmpty
        scene="bottle"
        title="No stashed prompts"
        hint={
          keys
            ? `Stash a half-written prompt with ${keys} and it waits here.`
            : "Stashed prompts wait here until you need them."
        }
      />
    );
  }
  const shown = entries.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((entry) => {
        const firstLine = entry.prompt.trim().split("\n")[0] ?? "";
        const attachments = entry.attachments.length + (entry.files?.length ?? 0);
        return (
          <Row key={entry.id} onClick={() => writeToComposer(composerRef, entry.prompt.trim())}>
            <span className="min-w-0 flex-1 truncate text-foreground">
              {firstLine || "Untitled prompt"}
            </span>
            {attachments > 0 ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-muted-foreground">
                <PaperclipIcon aria-hidden className="size-3" />
                {attachments}
              </span>
            ) : null}
            <Time>{ago(entry.createdAt, now)}</Time>
          </Row>
        );
      })}
      <More n={entries.length - shown.length} label="stashed" />
    </div>
  );
}

export function SkillsBody() {
  const { data, composerRef } = useWidgetEnv();
  const { bodyHeight, size } = useWidgetFrame();
  const project = data.project;
  const providers =
    useEnvironment(project?.environmentId ?? null)?.serverConfig?.providers ?? EMPTY_PROVIDERS;
  const recentInstance = data.projectThreads[0]?.providerInstanceId;
  const candidates = providers
    .filter((p) => p.enabled && p.installed)
    .sort(
      (a, b) => Number(b.instanceId === recentInstance) - Number(a.instanceId === recentInstance),
    );
  const match = candidates
    .map((candidate) => ({
      provider: candidate,
      skills: project
        ? getProviderSkillsForSlashMenu(
            resolveProviderSkillsForCwd(candidate, project.workspaceRoot),
            true,
          )
        : [],
    }))
    .find((entry) => entry.skills.length > 0);
  const provider = match?.provider ?? null;
  const skills = match?.skills ?? [];
  if (!provider || skills.length === 0) {
    return (
      <WidgetEmpty
        scene="chart"
        title="No skills here"
        hint="Skills your provider finds for this project show up here."
      />
    );
  }
  const shown = skills.slice(0, rowsThatFit(bodyHeight));
  return (
    <div className="flex flex-col">
      {shown.map((skill) => (
        <Row key={skill.name} onClick={() => writeToComposer(composerRef, `$${skill.name} `)}>
          <span className="shrink-0 font-mono text-xs text-info">${skill.name}</span>
          {size === "s" ? null : (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {skill.shortDescription ?? skill.description ?? ""}
            </span>
          )}
        </Row>
      ))}
      <More n={skills.length - shown.length} label="skills" />
    </div>
  );
}

export function CheckoutBody() {
  const { data } = useWidgetEnv();
  const { bodyHeight, size } = useWidgetFrame();
  const project = data.project;
  const status = useEnvironmentQuery(
    project
      ? vcsEnvironment.status({
          environmentId: project.environmentId,
          input: { cwd: project.workspaceRoot },
        })
      : null,
  ).data;
  if (!project) return null;
  if (!status) return <WidgetSkeleton rows={2} label="Reading the checkout" />;
  if (!status.isRepo) {
    return (
      <WidgetEmpty
        scene="dock"
        title="Not a git repository"
        hint={`${project.title} isn't tracked by git yet.`}
      />
    );
  }
  const files = status.workingTree.files;
  const fileRows = Math.max(0, Math.floor((bodyHeight - 64) / 24));
  return (
    <div className="flex h-full flex-col gap-2 px-3 pt-0.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 truncate font-mono text-sm text-foreground">
          {status.refName ?? "detached HEAD"}
        </span>
        {status.isDefaultRef ? (
          <span className="rounded-sm bg-muted px-1 text-2xs text-muted-foreground">default</span>
        ) : null}
        {status.hasUpstream && (status.aheadCount > 0 || status.behindCount > 0) ? (
          <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
            {status.aheadCount > 0 ? (
              <span className="inline-flex items-center">
                <ArrowUpIcon aria-label="ahead" className="size-3" />
                {status.aheadCount}
              </span>
            ) : null}
            {status.behindCount > 0 ? (
              <span className="inline-flex items-center">
                <ArrowDownIcon aria-label="behind" className="size-3" />
                {status.behindCount}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground">Clean. Nothing uncommitted.</p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <FileDiffIcon aria-hidden className="size-3.5" />
            <span className="tabular-nums">
              {files.length} changed {files.length === 1 ? "file" : "files"}
            </span>
            <span className="font-mono tabular-nums">
              <span className="text-diff-addition-foreground">
                +{status.workingTree.insertions}
              </span>{" "}
              <span className="text-diff-deletion-foreground">−{status.workingTree.deletions}</span>
            </span>
          </p>
          {size === "s" ? null : (
            <ul className="flex flex-col">
              {files.slice(0, fileRows).map((file) => (
                <li key={file.path} className="flex h-6 items-center gap-2 font-mono text-xs">
                  <span className="min-w-0 flex-1 truncate text-foreground">{file.path}</span>
                  <span className="shrink-0 tabular-nums text-diff-addition-foreground">
                    +{file.insertions}
                  </span>
                  <span className="shrink-0 tabular-nums text-diff-deletion-foreground">
                    −{file.deletions}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function localDay(ms: number) {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function SpendBody({ days }: { days: 1 | 7 }) {
  const { size } = useWidgetFrame();
  const now = useNowMinuteMs();
  const window = useMemo(() => makeWindow(days), [days]);
  const { merged, isPending, environments } = useUsage(window);
  if (isPending && merged.records === 0) {
    return <StatSkeleton label="Reading usage" />;
  }
  if (environments.length > 0 && environments.every((env) => !env.canReadDiagnostics)) {
    return (
      <WidgetEmpty
        scene="anchor"
        title="Spending is private here"
        hint="This connection can't read usage. Pair with diagnostics access to see it."
      />
    );
  }
  const providers = [...merged.providers]
    .filter((p) => p.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd);
  const costByDay = new Map(merged.daily.map((d) => [d.day, d.costUsd]));
  const today = localDay(now);
  const week = Array.from({ length: 7 }, (_, offset) => {
    const day = localDay(now - (6 - offset) * 86_400_000);
    return { day, costUsd: costByDay.get(day) ?? 0 };
  });
  const weekMax = Math.max(1, ...week.map((d) => d.costUsd));
  const showChart = days === 7 && size !== "s";
  const showProviders = size !== "s" && (days === 1 || size === "l" || size === "w");
  return (
    <div className="flex h-full flex-col justify-center gap-3 px-3">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-secondary-label">
            {days === 1 ? "Spent today" : "Last 7 days"}
          </span>
          <span className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">
            {formatUsd(merged.costUsd)}
          </span>
        </div>
        <span className="pb-1 text-right text-xs tabular-nums text-secondary-label">
          {formatTokens(merged.totalTokens)} tokens
          <br />
          at API prices
        </span>
      </div>
      {showChart ? (
        <figure
          className="flex h-14 items-end gap-1"
          aria-label={`Daily spend: ${week.map((d) => `${formatDayShort(d.day)} ${formatUsd(d.costUsd)}`).join(", ")}`}
        >
          {week.map((d) => (
            <span
              key={d.day}
              className="flex h-full flex-1 flex-col items-center justify-end gap-1"
            >
              <span
                className={cn(
                  "w-full rounded-t-xs",
                  d.day === today ? "bg-foreground/70" : "bg-foreground/20",
                )}
                style={{ height: `${Math.max(4, (d.costUsd / weekMax) * 100)}%` }}
              />
              <span className="text-3xs text-secondary-label">
                {new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "narrow" })}
              </span>
            </span>
          ))}
        </figure>
      ) : null}
      {showProviders ? (
        <ul className="flex flex-col gap-1">
          {providers.slice(0, 3).map((p) => {
            const presentation = PROVIDER_PRESENTATION[p.provider];
            return (
              <li key={p.provider} className="flex items-center gap-2 text-xs">
                <span className="w-20 shrink-0 truncate text-foreground">{presentation.label}</span>
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.round(p.costShare * 100)}%`,
                      backgroundColor: presentation.color,
                    }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-secondary-label">
                  {formatUsd(p.costUsd)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function SpendTodayBody() {
  return <SpendBody days={1} />;
}

export function SpendWeekBody() {
  return <SpendBody days={7} />;
}
