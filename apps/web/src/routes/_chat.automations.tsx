import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";

import { AutomationsPage } from "../components/automations/AutomationsPage";
import { validateAutomationsSearch } from "../components/automations/automations.logic";

function AutomationsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onProjectChange = useCallback(
    (project: string | undefined) => {
      void navigate({ search: project === undefined ? {} : { project } });
    },
    [navigate],
  );
  // Replace, so the remembered main-app URL and Back never reopen the editor.
  const onTaskLinkClosed = useCallback(() => {
    void navigate({
      search: (previous) => (previous.project === undefined ? {} : { project: previous.project }),
      replace: true,
    });
  }, [navigate]);
  return (
    <AutomationsPage
      search={search}
      onProjectChange={onProjectChange}
      onTaskLinkClosed={onTaskLinkClosed}
    />
  );
}

export const Route = createFileRoute("/_chat/automations")({
  validateSearch: validateAutomationsSearch,
  component: AutomationsRoute,
});
