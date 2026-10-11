import type { ComposerHandleRef } from "../../composerHandleContext";
import type { ProtoData } from "./data";
import { WidgetGrid } from "./widgets/Grid";

export function Widgets({
  data,
  composerRef,
}: {
  data: ProtoData;
  composerRef: ComposerHandleRef;
}) {
  return (
    <div className="chat-composer-lane pt-3 pb-7">
      <div className="mx-auto w-full max-w-5xl">
        <WidgetGrid env={{ data, composerRef }} />
      </div>
    </div>
  );
}
