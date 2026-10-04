import { createFileRoute } from "@tanstack/react-router";

import {
  redirectScheduledTasksToAutomations,
  validateAutomationsSearch,
} from "../components/automations/automations.logic";

export const Route = createFileRoute("/settings/scheduled-tasks")({
  validateSearch: validateAutomationsSearch,
  beforeLoad: redirectScheduledTasksToAutomations,
});
