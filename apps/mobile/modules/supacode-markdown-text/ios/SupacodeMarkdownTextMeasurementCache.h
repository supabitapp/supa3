#pragma once

#include "SupacodeMarkdownTextShadowNode.h"

#include <list>
#include <mutex>
#include <optional>

namespace facebook::react {

struct SupacodeMarkdownTextMeasurementKey {
  AttributedString attributedString;
  std::vector<SupacodeMarkdownTextParagraphStyleRange> paragraphStyles;
  std::vector<SupacodeMarkdownTextAttachmentRange> attachments;
  LayoutConstraints constraints;
  Float fontSizeMultiplier;
  Float pointScaleFactor;
  int numberOfLines;
  SupacodeMarkdownTextEllipsizeMode ellipsizeMode;

  bool operator==(const SupacodeMarkdownTextMeasurementKey &) const = default;

  size_t hash() const {
    auto seed = std::hash<AttributedString>{}(attributedString);
    hash_combine(seed, constraints, fontSizeMultiplier, pointScaleFactor, numberOfLines, ellipsizeMode);
    for (const auto &range : paragraphStyles) {
      hash_combine(seed, range.location, range.length, range.firstLineHeadIndent,
          range.headIndent, range.paragraphSpacing);
    }
    for (const auto &range : attachments) {
      hash_combine(seed, range.location, range.length, range.imageUri,
          range.tintWithForeground, range.chipWidth, range.chipHeight);
    }
    return seed;
  }

  size_t retainedBytes() const {
    size_t bytes = sizeof(*this);
    const auto &fragments = attributedString.getFragments();
    bytes += fragments.capacity() * sizeof(AttributedString::Fragment);
    for (const auto &fragment : fragments) {
      bytes += fragment.string.capacity() + fragment.textAttributes.fontFamily.capacity();
    }
    bytes += paragraphStyles.capacity() * sizeof(SupacodeMarkdownTextParagraphStyleRange);
    bytes += attachments.capacity() * sizeof(SupacodeMarkdownTextAttachmentRange);
    for (const auto &range : attachments) bytes += range.imageUri.capacity();
    return bytes;
  }
};

// Shared across shadow-node clones so unchanged layout retries reuse the size.
// Retain only C++ inputs and sizes; mutable TextKit objects stay on their calling thread.
class SupacodeMarkdownTextMeasurementCache {
 public:
  std::optional<Size> get(const SupacodeMarkdownTextMeasurementKey &key) {
    const auto hash = key.hash();
    std::lock_guard lock(mutex_);
    for (auto it = entries_.begin(); it != entries_.end(); ++it) {
      if (it->hash == hash && it->key == key) {
        const auto size = it->size;
        entries_.splice(entries_.begin(), entries_, it);
        return size;
      }
    }
    return std::nullopt;
  }

  void set(SupacodeMarkdownTextMeasurementKey key, Size size) {
    const auto bytes = key.retainedBytes();
    if (bytes > MaxBytes) return;
    const auto hash = key.hash();
    std::lock_guard lock(mutex_);
    for (auto it = entries_.begin(); it != entries_.end(); ++it) {
      if (it->hash == hash && it->key == key) {
        retainedBytes_ -= it->bytes;
        entries_.erase(it);
        break;
      }
    }
    while (!entries_.empty() && (entries_.size() >= MaxEntries || retainedBytes_ + bytes > MaxBytes)) {
      retainedBytes_ -= entries_.back().bytes;
      entries_.pop_back();
    }
    retainedBytes_ += bytes;
    entries_.push_front({std::move(key), size, hash, bytes});
  }

 private:
  static constexpr size_t MaxEntries = 64;
  static constexpr size_t MaxBytes = 8 * 1024 * 1024;
  struct Entry {
    SupacodeMarkdownTextMeasurementKey key;
    Size size;
    size_t hash;
    size_t bytes;
  };
  std::mutex mutex_;
  std::list<Entry> entries_;
  size_t retainedBytes_ = 0;
};
} // namespace facebook::react
