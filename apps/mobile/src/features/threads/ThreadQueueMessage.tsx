import type { ChatAttachment, EnvironmentId } from "@supacode/contracts";
import { Image } from "expo-image";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { useAssetUrl } from "../../state/assets";
import type { ThreadQueueRowControls } from "./threadQueueControlPresentation";

const THUMBNAIL_LIMIT = 3;

export type QueueMessageAction = "steer" | "edit" | "up" | "down" | "remove";

export function ThreadQueueMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly index: number;
  readonly title: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly controls: ThreadQueueRowControls;
  readonly canPromoteToSteer: boolean;
  readonly onAction: (action: QueueMessageAction) => void;
}) {
  let status = props.index === 0 ? "Up next" : `Queued ${props.index + 1}`;
  if (props.controls.isEditing) status = "Editing in composer";

  return (
    <View className="flex-row items-start">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.title}
        accessibilityHint="Opens this message in the composer for editing"
        accessibilityState={{ disabled: !props.controls.canEdit }}
        disabled={!props.controls.canEdit}
        onPress={() => props.onAction("edit")}
        className="min-w-0 flex-1 gap-2 py-4 pl-3 active:opacity-70"
      >
        <Text className="text-xs font-supacode-medium text-foreground-muted">{status}</Text>
        <Text className="text-base text-foreground" numberOfLines={3}>
          {props.title}
        </Text>
        <QueueAttachmentThumbnails
          environmentId={props.environmentId}
          attachments={props.attachments}
        />
      </Pressable>
      <ControlPillMenu
        accessibilityLabel={`Actions for queued message ${props.index + 1}`}
        actions={[
          ...(props.canPromoteToSteer
            ? [
                {
                  id: "steer",
                  title: "Steer now",
                  attributes: { disabled: !props.controls.canSteer },
                  image: Platform.OS === "ios" ? "arrow.turn.left.up" : "arrow_upward",
                },
              ]
            : []),
          {
            id: "edit",
            title: "Edit",
            attributes: { disabled: !props.controls.canEdit },
            image: Platform.OS === "ios" ? "pencil" : "edit",
          },
          { id: "up", title: "Move up", attributes: { disabled: !props.controls.canMoveUp } },
          {
            id: "down",
            title: "Move down",
            attributes: { disabled: !props.controls.canMoveDown },
          },
          {
            id: "remove",
            title: "Remove",
            attributes: { disabled: !props.controls.canDismiss, destructive: true },
          },
        ]}
        onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event as QueueMessageAction)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Actions for queued message ${props.index + 1}`}
          className="size-11 items-center justify-center active:opacity-70"
        >
          <SymbolView name="ellipsis" size={18} tintColorClassName="accent-foreground-muted" />
        </Pressable>
      </ControlPillMenu>
    </View>
  );
}

function QueueAttachmentThumbnails(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}) {
  const images = props.attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const shown = images.slice(0, THUMBNAIL_LIMIT);
  const overflow = props.attachments.length - shown.length;
  if (props.attachments.length === 0) return null;
  return (
    <View className="shrink-0 flex-row items-center gap-1">
      {shown.map((attachment) => (
        <QueueAttachmentThumbnail
          key={attachment.id}
          environmentId={props.environmentId}
          attachment={attachment}
        />
      ))}
      {overflow > 0 ? (
        <View className="h-6 min-w-6 items-center justify-center rounded bg-subtle px-1">
          <Text className="text-2xs tabular-nums text-foreground-muted">
            {shown.length === 0 ? `${overflow}` : `+${overflow}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function QueueAttachmentThumbnail(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
}) {
  const url = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachment.id,
    fileName: props.attachment.name,
    mimeType: props.attachment.mimeType,
    disposition: "inline",
  });
  if (url === null) {
    return <View className="h-6 w-6 rounded bg-subtle" />;
  }
  return (
    <Image
      source={{ uri: url }}
      contentFit="cover"
      style={{ width: 24, height: 24, borderRadius: 4 }}
      accessibilityIgnoresInvertColors
    />
  );
}
