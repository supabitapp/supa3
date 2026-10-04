import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateAutomationsSearch } from "../components/automations/automations.logic";

// Scheduled tasks moved to Automations. Old links keep their project filter and
// task; the settings machine and checkout scope have no equivalent there.
export const Route = createFileRoute("/settings/scheduled-tasks")({
  validateSearch: validateAutomationsSearch,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/automations",
      search: validateAutomationsSearch(search),
      replace: true,
    });
  },
});
