#import "SupacodeMarkdownTextConversion.h"
#include "SupacodeMarkdownTextMeasurementCache.h"

#include <cassert>
#include <chrono>
#include <iostream>
#include <thread>

using namespace facebook::react;
using TextSize = facebook::react::Size;

static SupacodeMarkdownTextMeasurementKey keyFor(std::string text) {
  AttributedString textValue;
  AttributedString::Fragment fragment;
  fragment.string = std::move(text);
  fragment.textAttributes = TextAttributes::defaultTextAttributes();
  textValue.appendFragment(std::move(fragment));
  LayoutConstraints constraints;
  constraints.maximumSize.width = 320;
  return {std::move(textValue), {}, {}, constraints, 1, 2, 0, SupacodeMarkdownTextEllipsizeMode::Tail};
}

static void cacheChecks() {
  SupacodeMarkdownTextMeasurementCache cache;
  const auto key = keyFor("A paragraph with Unicode: 漢字 👩🏽‍💻 é مرحبا");
  const TextSize measured{280, 120};
  cache.set(key, measured);
  assert(cache.get(keyFor(key.attributedString.getString())) == measured);

  auto changed = key;
  changed.constraints.maximumSize.width = 180;
  assert(!cache.get(changed));
  changed = key;
  changed.constraints.minimumSize.height = 200;
  assert(!cache.get(changed));
  changed = key;
  changed.constraints.layoutDirection = LayoutDirection::RightToLeft;
  assert(!cache.get(changed));
  changed = key;
  changed.pointScaleFactor = 3;
  assert(!cache.get(changed));
  changed = key;
  changed.fontSizeMultiplier = 2;
  assert(!cache.get(changed));
  changed = key;
  changed.numberOfLines = 1;
  assert(!cache.get(changed));
  changed = key;
  changed.ellipsizeMode = SupacodeMarkdownTextEllipsizeMode::Head;
  assert(!cache.get(changed));
  changed = key;
  changed.paragraphStyles.push_back({0, 1, 4, 8, 12});
  assert(!cache.get(changed));
  changed = key;
  changed.attachments.push_back({0, 1, "sf:folder", true, 30, 18});
  assert(!cache.get(changed));
  assert(!cache.get(keyFor("Corrected content")));

  // A scan evicts old entries instead of retaining every streamed revision.
  for (int index = 0; index < 100; ++index) cache.set(keyFor(std::to_string(index)), measured);
  assert(!cache.get(key));
  assert(cache.get(keyFor("99")) == measured);
  auto oversized = keyFor(std::string(9 * 1024 * 1024, 'x'));
  cache.set(oversized, measured);
  assert(!cache.get(oversized));

  std::vector<std::thread> workers;
  for (int worker = 0; worker < 8; ++worker) {
    workers.emplace_back([&, worker] {
      const auto input = keyFor("worker " + std::to_string(worker));
      const TextSize expected{100, static_cast<Float>(worker)};
      for (int iteration = 0; iteration < 1000; ++iteration) {
        cache.set(input, expected);
        assert(cache.get(input) == expected);
      }
    });
  }
  for (auto &worker : workers) worker.join();
}

static void conversionChecks() {
  AttributedString text;
  const std::vector<std::string> samples{
      "Latin\n", "漢字 ", "👩🏽‍💻 ", "é ", "مرحبا ", std::string("a\0b", 3), " tail",
  };
  for (size_t index = 0; index < samples.size(); ++index) {
    AttributedString::Fragment fragment;
    fragment.string = samples[index];
    fragment.textAttributes = TextAttributes::defaultTextAttributes();
    fragment.textAttributes.fontFamily = "Helvetica Neue";
    fragment.textAttributes.fontSize = 16;
    fragment.textAttributes.lineHeight = 23;
    if (index % 2) fragment.textAttributes.fontWeight = FontWeight::Bold;
    if (index % 3) fragment.textAttributes.fontStyle = FontStyle::Italic;
    if (index % 4) fragment.textAttributes.textDecorationLineType = TextDecorationLineType::Underline;
    text.appendFragment(std::move(fragment));
  }
  assert([RCTNSAttributedStringFromAttributedString(text)
      isEqualToAttributedString:SupacodeMarkdownTextConvertAttributedString(text)]);

  for (const auto transform : {TextTransform::Uppercase, TextTransform::Lowercase, TextTransform::Capitalize}) {
    AttributedString transformed;
    auto fragment = text.getFragments().front();
    fragment.string = "mIxEd case 漢字 مرحبا";
    fragment.textAttributes.textTransform = transform;
    transformed.appendFragment(std::move(fragment));
    assert([RCTNSAttributedStringFromAttributedString(transformed)
        isEqualToAttributedString:SupacodeMarkdownTextConvertAttributedString(transformed)]);
  }

  AttributedString dense;
  for (int index = 0; index < 3000; ++index) {
    auto fragment = text.getFragments()[index % samples.size()];
    dense.appendFragment(std::move(fragment));
  }
  auto bench = [&](bool reuseStyles) {
    const auto start = std::chrono::steady_clock::now();
    for (int iteration = 0; iteration < 10; ++iteration) {
      @autoreleasepool {
        NSAttributedString *result = reuseStyles ? SupacodeMarkdownTextConvertAttributedString(dense)
            : RCTNSAttributedStringFromAttributedString(dense);
        assert(result.length > 0);
      }
    }
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count() / 10;
  };
  const auto referenceMs = bench(false);
  const auto reusedMs = bench(true);
  std::cout << "conversion_ms: reference=" << referenceMs << " reused_styles=" << reusedMs << '\n';
}

int main() {
  @autoreleasepool {
    cacheChecks();
    conversionChecks();
  }
  std::cout << "Cache invalidation, eviction, concurrency, and RN conversion parity passed.\n";
}
