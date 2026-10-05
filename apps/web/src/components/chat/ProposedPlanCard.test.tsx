import { EnvironmentId } from "@supacode/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProposedPlanCard } from "./ProposedPlanCard";

function Wrapper(props: { readonly children?: ReactNode }) {
  return <>{props.children}</>;
}
vi.mock("../ChatMarkdown", () => ({
  default: (props: { text: string }) => <article>{props.text}</article>,
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("../ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/badge", () => ({ Badge: Wrapper }));
vi.mock("../ui/menu", () => ({
  Menu: Wrapper,
  MenuItem: Wrapper,
  MenuPopup: Wrapper,
  MenuTrigger: Wrapper,
}));
vi.mock("../ui/dialog", () => ({
  Dialog: (props: { open: boolean; children?: ReactNode }) =>
    props.open ? <>{props.children}</> : null,
  DialogDescription: Wrapper,
  DialogFooter: Wrapper,
  DialogHeader: Wrapper,
  DialogPanel: Wrapper,
  DialogPopup: Wrapper,
  DialogTitle: Wrapper,
}));

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

it("reveals a found plan's hidden body and restores its prior collapsed view on close", () => {
  const planMarkdown =
    "# Plan\n\n" +
    Array.from({ length: 30 }, (_, index) => `- Step ${index + 1}`).join("\n") +
    "\n\nneedle at the end";
  const render = (forceExpanded: boolean) => {
    const card = (
      <ProposedPlanCard
        planMarkdown={planMarkdown}
        environmentId={EnvironmentId.make("environment")}
        cwd={undefined}
        workspaceRoot={undefined}
        forceExpanded={forceExpanded}
      />
    );
    act(() => {
      if (renderer) renderer.update(card);
      else renderer = create(card);
    });
    return renderer!.root.findByType("article").children.join("");
  };
  expect(render(false)).not.toContain("needle at the end");
  expect(render(true)).toContain("needle at the end");
  expect(render(false)).not.toContain("needle at the end");
});
