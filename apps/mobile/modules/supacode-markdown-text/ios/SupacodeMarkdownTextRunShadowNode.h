#pragma once

#include <react/renderer/components/SupacodeMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/SupacodeMarkdownTextSpec/Props.h>
#include <react/renderer/components/SupacodeMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char SupacodeMarkdownTextRunComponentName[];

using SupacodeMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    SupacodeMarkdownTextRunComponentName,
    SupacodeMarkdownTextRunProps,
    SupacodeMarkdownTextRunEventEmitter,
    SupacodeMarkdownTextRunState>;
}
