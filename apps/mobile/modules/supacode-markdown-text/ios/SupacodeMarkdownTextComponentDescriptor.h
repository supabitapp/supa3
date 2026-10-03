#pragma once

#include "SupacodeMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using SupacodeMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<SupacodeMarkdownTextShadowNode>;

void SupacodeMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
