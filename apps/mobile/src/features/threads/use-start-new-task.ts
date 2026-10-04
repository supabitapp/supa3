import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import {
  ensureComposerDraftsLoaded,
  stickyNewTaskProjectAtom,
} from "../../state/use-composer-drafts";

/**
 * The compose action: opens a draft in the last project a new task targeted,
 * or the project picker when there is none or it no longer exists. Reads at
 * press time so callers do not re-render on project changes.
 */
export function useStartNewTask(): () => void {
  const navigation = useNavigation();
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return useCallback(() => {
    const ref = appAtomRegistry.get(stickyNewTaskProjectAtom);
    const project = ref ? appAtomRegistry.get(environmentProjects.projectAtom(ref)) : null;
    if (!project) {
      navigation.navigate("NewTaskSheet", { screen: "NewTask" });
      return;
    }
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
      },
    });
  }, [navigation]);
}
