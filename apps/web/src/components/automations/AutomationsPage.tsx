import {
  ChevronDownIcon,
  Clock3Icon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ScheduledTask, ScheduledTaskId } from "@supacode/contracts";
import { resolveEnvironmentMachineKind } from "@supacode/contracts";
import { scopeThreadRef } from "@supacode/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@supacode/client-runtime/state/runtime";

import { isElectron } from "../../env";
import { useInlineConfirm } from "../../hooks/useInlineConfirm";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { projectGroupMemberKeys, type SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AutomationEditorDialog } from "./AutomationEditorDialog";
import { inProjectFilter, lastRunLabel, nextRunLabel, scheduleLabel } from "./automations.logic";

const route = getRouteApi("/_chat/automations");

const ALL_PROJECTS = "";

function statusVariant(status: ScheduledTask["lastRunStatus"]) {
  if (status === "failed") return "error";
  if (status === "succeeded") return "success";
  if (status === "running") return "info";
  return "outline";
}

/**
 * Every environment's scheduled tasks in one list. The optional project filter
 * narrows both the list and the projects a new automation can target.
 */
export function AutomationsPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const groups = useSettingsProjectGroups();
  const { environments: availableEnvironments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const filteredGroup = groups.find((group) => group.projectKey === search.project) ?? null;
  const filteredProjectMissing = search.project !== undefined && filteredGroup === null;
  const projectKeys = useMemo(
    () => (filteredGroup ? projectGroupMemberKeys(filteredGroup) : null),
    [filteredGroup],
  );
  // A filtered project's environments; none when the project is gone.
  const environments = availableEnvironments.filter(
    (environment) =>
      search.project === undefined ||
      filteredGroup?.memberProjectRefs.some(
        (ref) => ref.environmentId === environment.environmentId,
      ) === true,
  );
  const connectedEnvironments = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const defaultEnvironment =
    connectedEnvironments.find(
      (environment) => environment.environmentId === primaryEnvironmentId,
    ) ?? connectedEnvironments[0];
  const projectNameByKey = useMemo(
    () =>
      new Map(
        groups.flatMap((group) =>
          [...projectGroupMemberKeys(group)].map((key) => [key, group.displayName] as const),
        ),
      ),
    [groups],
  );
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    task: ScheduledTask | null;
  } | null>(null);
  const openForEdit = useCallback((environmentId: EnvironmentId, task: ScheduledTask) => {
    setEditor({ environmentId, task });
  }, []);
  const hasTaskLink = search.environmentId !== undefined || search.taskId !== undefined;
  const closeEditor = () => {
    setEditor(null);
    if (!hasTaskLink) return;
    void navigate({
      search: (previous) => (previous.project === undefined ? {} : { project: previous.project }),
      replace: true,
    });
  };
  const linkEnvironmentId = search.environmentId ?? defaultEnvironment?.environmentId;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Automations breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem>
              <h1>Automations</h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10">
              <AutomationProjectFilter
                groups={groups}
                value={search.project}
                onChange={(project) =>
                  void navigate({ search: project === undefined ? {} : { project } })
                }
              />
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <Button
            size="xs"
            variant="outline"
            disabled={!defaultEnvironment}
            onClick={() =>
              defaultEnvironment &&
              setEditor({ environmentId: defaultEnvironment.environmentId, task: null })
            }
          >
            <PlusIcon />
            New automation
          </Button>
        </WorkspacePageHeader>

        <div className="topbar-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto">
          <WorkspacePageContainer className="gap-8">
            {filteredProjectMissing ? (
              <p className="text-sm text-muted-foreground">This project is no longer available.</p>
            ) : environments.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Clock3Icon />
                  </EmptyMedia>
                  <EmptyTitle>No environments available</EmptyTitle>
                  <EmptyDescription>Connect an environment to manage automations.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              environments.map((entry) => (
                <AutomationEnvironmentSection
                  key={`${entry.environmentId}:${search.taskId ?? ""}`}
                  environment={entry}
                  projectKeys={projectKeys}
                  showEnvironmentHeading={environments.length > 1}
                  projectNameByKey={projectNameByKey}
                  taskId={linkEnvironmentId === entry.environmentId ? search.taskId : undefined}
                  onEdit={openForEdit}
                />
              ))
            )}
          </WorkspacePageContainer>
        </div>
      </div>
      {editor ? (
        <AutomationEditorDialog
          key={`${editor.environmentId}:${editor.task?.id ?? "new"}`}
          initialEnvironmentId={editor.environmentId}
          task={editor.task}
          projectKeys={projectKeys}
          connectedEnvironments={connectedEnvironments}
          onClose={closeEditor}
        />
      ) : null}
    </SidebarInset>
  );
}

function AutomationProjectFilter({
  groups,
  value,
  onChange,
}: {
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly value: string | undefined;
  readonly onChange: (project: string | undefined) => void;
}) {
  const selected = groups.find((group) => group.projectKey === value);
  return (
    <Menu>
      <MenuTrigger
        render={<InlineButton />}
        aria-label="Filter automations by project"
        className="group/automation-project min-w-0 max-w-full"
      >
        <span className="min-w-0 truncate">
          {value === undefined ? "All projects" : (selected?.displayName ?? "Unavailable project")}
        </span>
        <ChevronDownIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/automation-project:opacity-100 group-focus-visible/automation-project:opacity-100 group-data-popup-open/automation-project:opacity-100"
        />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          value={value ?? ALL_PROJECTS}
          onValueChange={(next: string) => onChange(next === ALL_PROJECTS ? undefined : next)}
        >
          <MenuRadioItem value={ALL_PROJECTS} closeOnClick>
            All projects
          </MenuRadioItem>
          {groups.length > 0 ? <MenuSeparator /> : null}
          {groups.map((group) => (
            <MenuRadioItem key={group.projectKey} value={group.projectKey} closeOnClick>
              <span className="min-w-0 truncate">{group.displayName}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function AutomationEnvironmentSection({
  environment,
  projectKeys,
  showEnvironmentHeading,
  projectNameByKey,
  taskId,
  onEdit,
}: {
  readonly environment: EnvironmentPresentation;
  readonly projectKeys: ReadonlySet<string> | null;
  readonly showEnvironmentHeading: boolean;
  readonly projectNameByKey: ReadonlyMap<string, string>;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const tasks = tasksQuery.data?.tasks.filter((task) =>
    inProjectFilter(projectKeys, environment.environmentId, task.projectId),
  );
  const linkedTask = tasks?.find((task) => task.id === taskId);
  const openedLink = useRef(false);
  useEffect(() => {
    if (!openedLink.current && linkedTask) {
      openedLink.current = true;
      onEdit(environment.environmentId, linkedTask);
    }
  }, [environment.environmentId, linkedTask, onEdit]);
  const now = useNowMinuteMs();
  return (
    <SettingsSection
      title={environment.label}
      hideTitle={!showEnvironmentHeading}
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {!connected ? (
        <SettingsRow
          title="Environment disconnected"
          description={`Reconnect ${environment.label} to view its automations.`}
        />
      ) : tasksQuery.error ? (
        <SettingsRow title="Could not load automations" description={tasksQuery.error} />
      ) : !tasks ? (
        <SettingsRow title="Loading automations…" role="status" />
      ) : (
        <>
          {taskId && !linkedTask ? (
            <SettingsRow
              title="Automation unavailable"
              description="This automation no longer exists or is outside the selected project."
              role="status"
            />
          ) : null}
          {tasks.length === 0 ? (
            <SettingsRow
              title="No automations"
              description="Create one to run a prompt on a schedule."
            />
          ) : (
            tasks.map((task) => (
              <AutomationRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                projectName={
                  projectNameByKey.get(`${environment.environmentId}:${task.projectId}`) ?? null
                }
                now={now}
                onEdit={() => onEdit(environment.environmentId, task)}
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

function AutomationRow({
  environmentId,
  task,
  projectName,
  now,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly projectName: string | null;
  readonly now: number;
  readonly onEdit: () => void;
}) {
  const navigate = useNavigate();
  const threadRef = useMemo(
    () => (task.threadId ? scopeThreadRef(environmentId, task.threadId) : null),
    [environmentId, task.threadId],
  );
  const thread = useThreadShell(threadRef);
  const [busy, setBusy] = useState(false);
  const confirm = useInlineConfirm<"delete">();
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const act = async (action: "toggle" | "run" | "delete") => {
    if (busy) return;
    setBusy(true);
    const result =
      action === "toggle"
        ? await toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } })
        : action === "run"
          ? await run({ environmentId, input: { id: task.id } })
          : await remove({ environmentId, input: { id: task.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not update automation",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  const lastRun = lastRunLabel(task, now);
  const target = threadRef
    ? `In ${thread?.title ? `"${thread.title}"` : "its thread"}`
    : "New thread each run";
  return (
    <SettingsRow
      title={task.title}
      description={<span className="line-clamp-2">{task.prompt}</span>}
      status={
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {[
              projectName ?? "Project removed",
              target,
              scheduleLabel(task.schedule),
              nextRunLabel(task, now),
            ].join(" · ")}
          </span>
          {lastRun ? <Badge variant={statusVariant(task.lastRunStatus)}>{lastRun}</Badge> : null}
          {task.lastRunError ? <span className="text-destructive">{task.lastRunError}</span> : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={task.enabled}
            disabled={busy}
            aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
            onCheckedChange={() => void act("toggle")}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Actions for ${task.title}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuItem disabled={task.lastRunStatus === "running"} onClick={() => void act("run")}>
                <PlayIcon />
                Run now
              </MenuItem>
              {threadRef ? (
                <MenuItem
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(threadRef),
                    })
                  }
                >
                  <MessageSquareIcon />
                  Open thread
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem {...confirm.bind("delete", () => void act("delete"))} variant="destructive">
                <Trash2Icon />
                {confirm.armed === "delete" ? "Confirm delete" : "Delete"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    />
  );
}
