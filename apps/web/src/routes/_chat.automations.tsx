import { createFileRoute } from "@tanstack/react-router";

import { AutomationsPage } from "../components/automations/AutomationsPage";
import { validateAutomationsSearch } from "../components/automations/automations.logic";

export const Route = createFileRoute("/_chat/automations")({
  validateSearch: validateAutomationsSearch,
  component: AutomationsPage,
});
