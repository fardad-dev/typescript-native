// src/codegen/cpp/tsn_runtime.h — the fixed C++ runtime for generated programs.
//
// Every program `tsnc` emits is just this header `#include`d on top, followed by
// the program-specific C++ (see src/codegen/emit.ts -> emitModule). This file
// holds everything that is program-INDEPENDENT:
//
//   - tsn_str: a ref-counted, immutable string;
//   - JS-semantics numeric/string/array runtime helpers (tsn_mod, tsn_substring,
//     tsn_push, ...);
//   - the scalar + array `tsn_inspect` overloads that back console.log.
//
// The program-DEPENDENT pieces stay in the generated .cpp: the per-object-shape
// structs, the per-type `tsn_inspect` overloads (one per object struct / class),
// the user's functions, and `main`. Splitting the fixed runtime out keeps it as
// real, editable C++ (with tooling support) instead of a giant string literal,
// and shrinks the generated .cpp to just what's unique about the program.
//
// Everything here is `static` / `inline` / a template, so including it in a
// single translation unit raises no ODR concerns.
#pragma once

#include <array>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

// A scope guard backing `try { … } finally { … }`. `try`'s `finally` block must
// run on *every* exit from the protected region — normal completion, an early
// `return`, or an exception unwinding through it — which is exactly what a C++
// destructor guarantees. The emitter wraps the protected region in a block with a
// `tsn_finally_guard` local whose destructor runs the finally body, so codegen
// needs no C++ `try` for a finally (only for a `catch`). The guard is move-only
// (C++17 guaranteed copy elision means `tsn_make_finally(...)` never actually
// copies/moves), and `active` ensures the body runs exactly once. The emitter
// rejects `return`/`throw`/escaping `break`/`continue` *inside* a finally body,
// so the destructor-run closure never itself returns or throws.
template <class F>
struct tsn_finally_guard {
  F fn;
  bool active;
  explicit tsn_finally_guard(F f) : fn(std::move(f)), active(true) {}
  tsn_finally_guard(tsn_finally_guard&& o) noexcept
      : fn(std::move(o.fn)), active(o.active) {
    o.active = false;
  }
  tsn_finally_guard(const tsn_finally_guard&) = delete;
  tsn_finally_guard& operator=(const tsn_finally_guard&) = delete;
  ~tsn_finally_guard() { if (active) fn(); }
};
template <class F>
static tsn_finally_guard<F> tsn_make_finally(F f) {
  return tsn_finally_guard<F>(std::move(f));
}

// `string` is a ref-counted, immutable string. TypeScript strings are
// immutable, so a value can be freely shared: copying one bumps a counter
// and aliases the same heap buffer instead of duplicating the characters.
// That makes the costly operation in element-shuffling code (e.g. a sort's
// `a[j+1] = a[j]`) a pointer copy + counter bump rather than a char copy —
// the same trick V8 uses. The refcount is a plain (non-atomic) long: the
// generated programs are single-threaded, so no atomics are needed.
struct tsn_str {
  struct Rep { std::string s; long rc; };
  Rep* p;
  tsn_str() noexcept : p(nullptr) {}
  tsn_str(const char* c) : p(new Rep{std::string(c), 1}) {}
  tsn_str(std::string s) : p(new Rep{std::move(s), 1}) {}
  tsn_str(const tsn_str& o) noexcept : p(o.p) { if (p) ++p->rc; }
  tsn_str(tsn_str&& o) noexcept : p(o.p) { o.p = nullptr; }
  tsn_str& operator=(const tsn_str& o) noexcept {
    if (o.p) ++o.p->rc;
    release();
    p = o.p;
    return *this;
  }
  tsn_str& operator=(tsn_str&& o) noexcept {
    if (this != &o) { release(); p = o.p; o.p = nullptr; }
    return *this;
  }
  ~tsn_str() { release(); }
  void release() noexcept { if (p && --p->rc == 0) delete p; }
  // p is null only for a moved-from value (left behind by vector growth or a
  // by-value return) — never read in generated code, but treat it as the
  // empty string so an accessor can never dereference null. The `p ?` branch
  // is perfectly predicted (always true in practice), so it costs nothing.
  const std::string& str() const noexcept {
    static const std::string empty;
    return p ? p->s : empty;
  }
  std::size_t size() const noexcept { return p ? p->s.size() : 0; }
  operator const std::string&() const noexcept { return str(); }
};
inline bool operator<(const tsn_str& a, const tsn_str& b) { return a.str() < b.str(); }
inline bool operator<=(const tsn_str& a, const tsn_str& b) { return a.str() <= b.str(); }
inline bool operator>(const tsn_str& a, const tsn_str& b) { return a.str() > b.str(); }
inline bool operator>=(const tsn_str& a, const tsn_str& b) { return a.str() >= b.str(); }
inline bool operator==(const tsn_str& a, const tsn_str& b) { return a.str() == b.str(); }
inline bool operator!=(const tsn_str& a, const tsn_str& b) { return a.str() != b.str(); }
inline tsn_str operator+(const tsn_str& a, const tsn_str& b) { return tsn_str(a.str() + b.str()); }
inline std::ostream& operator<<(std::ostream& os, const tsn_str& s) { return os << s.str(); }

// `number` is a double; print it JS-style (shortest round-trip, integers
// without a trailing ".0") via std::to_chars. NaN/Infinity get their JS
// spellings — std::to_chars would emit "nan"/"inf".
static std::string tsn_num_to_string(double v) {
  if (std::isnan(v)) return "NaN";
  if (std::isinf(v)) return v < 0 ? "-Infinity" : "Infinity";
  std::array<char, 32> buf;
  auto res = std::to_chars(buf.data(), buf.data() + buf.size(), v);
  return std::string(buf.data(), res.ptr);
}

// JS `%` on an f64. Fast path: when both operands are integer-valued and in
// the exactly-representable range, use the CPU's integer remainder (one
// instruction) instead of std::fmod (a libm call that dominated hot loops).
// The range guard makes the long long casts well-defined; the `== a` checks
// confirm both operands were integral. Otherwise fall back to true fmod.
// All three (int %, fmod, JS %) truncate toward zero, so results agree.
static inline double tsn_mod(double a, double b) {
  if (b != 0.0 && std::fabs(a) < 9007199254740992.0 &&
      std::fabs(b) < 9007199254740992.0) {
    long long ia = (long long)a, ib = (long long)b;
    if ((double)ia == a && (double)ib == b) return (double)(ia % ib);
  }
  return std::fmod(a, b);
}

// JS `%` on operands already known to be integers (the i64 rep). Skips the
// integral-ness guards tsn_mod needs and uses one hardware remainder; the
// `b ?` guard keeps `x % 0` defined as NaN (JS semantics) instead of UB.
// The result is a double, so a NaN from `% 0` stays representable.
static inline double tsn_imod(long long a, long long b) {
  return b ? (double)(a % b) : NAN;
}

// JS truthiness, used by `||`/`&&` (which return an operand, not a coerced
// bool). 0 and NaN are falsy numbers; "" is a falsy string; a null reference
// (only a not-yet-initialized global) is falsy, every live object/array/
// instance truthy.
static inline bool tsn_truthy(double v) { return v != 0.0 && !std::isnan(v); }
static inline bool tsn_truthy(long long v) { return v != 0; }
static inline bool tsn_truthy(bool b) { return b; }
static inline bool tsn_truthy(const tsn_str& s) { return s.size() != 0; }
template <class T> static inline bool tsn_truthy(const std::shared_ptr<T>& p) { return (bool)p; }

// String methods, matching JS String.prototype semantics. Indices are JS
// numbers (doubles): NaN (the sentinel an omitted optional arg lowers to)
// means "default"; otherwise truncate toward zero, then clamp. substring
// clamps negatives to 0 and swaps a start > end; slice counts negatives
// from the end. indexOf returns a 0-based position or -1.
static tsn_str tsn_substring(const std::string& s, double startD, double endD) {
  long long len = (long long)s.size();
  long long start = std::isnan(startD) ? 0 : (long long)startD;
  long long end = std::isnan(endD) ? len : (long long)endD;
  if (start < 0) start = 0;
  if (end < 0) end = 0;
  if (start > len) start = len;
  if (end > len) end = len;
  if (start > end) { long long t = start; start = end; end = t; }
  return s.substr((std::size_t)start, (std::size_t)(end - start));
}

static tsn_str tsn_slice(const std::string& s, double startD, double endD) {
  long long len = (long long)s.size();
  long long start = std::isnan(startD) ? 0 : (long long)startD;
  long long end = std::isnan(endD) ? len : (long long)endD;
  if (start < 0) start = len + start;
  if (end < 0) end = len + end;
  if (start < 0) start = 0;
  if (end < 0) end = 0;
  if (start > len) start = len;
  if (end > len) end = len;
  if (start >= end) return std::string();
  return s.substr((std::size_t)start, (std::size_t)(end - start));
}

static double tsn_index_of(const std::string& s, const std::string& sub, double fromD) {
  long long from = std::isnan(fromD) ? 0 : (long long)fromD;
  if (from < 0) from = 0;
  if (from > (long long)s.size()) return sub.empty() ? (double)s.size() : -1.0;
  std::size_t pos = s.find(sub, (std::size_t)from);
  return pos == std::string::npos ? -1.0 : (double)pos;
}

static tsn_str tsn_char_at(const std::string& s, double idxD) {
  long long i = std::isnan(idxD) ? 0 : (long long)idxD;
  if (i < 0 || i >= (long long)s.size()) return std::string();
  return std::string(1, s[(std::size_t)i]);
}

static double tsn_char_code_at(const std::string& s, double idxD) {
  long long i = std::isnan(idxD) ? 0 : (long long)idxD;
  if (i < 0 || i >= (long long)s.size()) return NAN;
  return (double)(unsigned char)s[(std::size_t)i];
}

static tsn_str tsn_to_upper(std::string s) {
  for (char& c : s) c = (char)std::toupper((unsigned char)c);
  return s;
}

static tsn_str tsn_to_lower(std::string s) {
  for (char& c : s) c = (char)std::tolower((unsigned char)c);
  return s;
}

// JS String.prototype.split with a STRING separator (regex is outside the
// subset). Mirrors JS edge cases: an empty separator splits into single
// characters; a separator that never matches yields a one-element array of
// the whole string; consecutive separators produce empty pieces. `limit`
// (NaN = absent) caps the number of pieces; <= 0 yields an empty array.
static std::vector<tsn_str> tsn_split(const std::string& s, const std::string& sep, double limitD) {
  std::vector<tsn_str> out;
  std::size_t cap = std::isnan(limitD) ? (std::size_t)-1
                  : (limitD <= 0.0 ? 0 : (std::size_t)limitD);
  if (cap == 0) return out;
  if (sep.empty()) {
    for (std::size_t i = 0; i < s.size() && out.size() < cap; ++i)
      out.push_back(tsn_str(std::string(1, s[i])));
    return out;
  }
  std::size_t start = 0;
  while (out.size() < cap) {
    std::size_t pos = s.find(sep, start);
    if (pos == std::string::npos) { out.push_back(tsn_str(s.substr(start))); break; }
    out.push_back(tsn_str(s.substr(start, pos - start)));
    start = pos + sep.size();
  }
  return out;
}

// JS Array.prototype.join: stringify each element JS-style and concatenate
// with the separator. Overloaded by element type — strings stream verbatim,
// numbers go through the shortest-round-trip formatter — matching how `+`
// coerces operands during concatenation.
static tsn_str tsn_join(const std::vector<tsn_str>& v, const std::string& sep) {
  std::string out;
  for (std::size_t i = 0; i < v.size(); ++i) { if (i) out += sep; out += v[i].str(); }
  return tsn_str(out);
}
static tsn_str tsn_join(const std::vector<double>& v, const std::string& sep) {
  std::string out;
  for (std::size_t i = 0; i < v.size(); ++i) { if (i) out += sep; out += tsn_num_to_string(v[i]); }
  return tsn_str(out);
}

// Array methods (templates over the element type T). push/pop take the
// receiver by mutable reference so the mutation is visible to the caller;
// slice/indexOf take it by const& (no copy, read-only).
//
// JS Array.prototype.push: append, return the new length (as an f64 number,
// like the other number-returning methods). The element forwards through a
// second deduced type U, so an i64 literal converts to a double element and
// an rvalue aggregate moves instead of copying.
template <class T, class U>
static double tsn_push(std::vector<T>& v, U&& x) {
  v.push_back(std::forward<U>(x));
  return static_cast<double>(v.size());
}

// JS Array.prototype.pop: remove and return the last element. This subset has
// no `undefined`, so popping an empty array yields the element type's default
// (0 for number, "" for string) rather than `undefined`.
template <class T>
static T tsn_pop(std::vector<T>& v) {
  if (v.empty()) return T();
  T x = std::move(v.back());
  v.pop_back();
  return x;
}

// JS Array.prototype.slice: a shallow copy of [start, end). Negatives count
// from the end; an omitted (NaN) start/end defaults to 0/length. Mirrors the
// index handling of the string tsn_slice helper.
template <class T>
static std::vector<T> tsn_array_slice(const std::vector<T>& v, double startD, double endD) {
  long long len = (long long)v.size();
  long long start = std::isnan(startD) ? 0 : (long long)startD;
  long long end = std::isnan(endD) ? len : (long long)endD;
  if (start < 0) start = len + start;
  if (end < 0) end = len + end;
  if (start < 0) start = 0;
  if (end < 0) end = 0;
  if (start > len) start = len;
  if (end > len) end = len;
  if (start >= end) return std::vector<T>();
  return std::vector<T>(v.begin() + start, v.begin() + end);
}

// JS Array.prototype.indexOf: first index where the element === x, else -1.
// fromIndex (NaN = 0) may be negative (counts from the end). Element equality
// uses operator==, defined for number/string/boolean (and instance identity).
template <class T>
static double tsn_array_index_of(const std::vector<T>& v, const T& x, double fromD) {
  long long len = (long long)v.size();
  long long from = std::isnan(fromD) ? 0 : (long long)fromD;
  if (from < 0) { from = len + from; if (from < 0) from = 0; }
  for (long long i = from; i < len; ++i)
    if (v[(std::size_t)i] == x) return (double)i;
  return -1.0;
}

// --- JS-style value printing (console.log) ------------------------------
//
// console.log routes booleans, arrays, objects and class instances through
// `tsn_inspect`, which mirrors Node's `util.inspect` single-line format:
// booleans `true`/`false`, arrays `[ e0, e1 ]`, objects `{ k: v, ... }`, class
// instances `Name { k: v, ... }`, and strings *quoted* (`'x'`) when nested.
//
// This header carries the program-INDEPENDENT half: the scalar overloads, the
// `tsn_quote` helper, and the array-inspect template (declaration + definition).
// The per-object-struct / per-class overloads are generated into the .cpp (they
// know the field names). The array template calls `tsn_inspect((*a)[i])` on a
// dependent element type, so for an object/class element it resolves the
// per-type overload via ADL at the instantiation point in the generated code
// (those overloads live in the global namespace alongside their struct/class).
//
// The quote and escape characters are built from their byte values (39 = `'`,
// 92 = `\`), so this C++ contains no backslashes — nothing fragile to re-escape.
static std::string tsn_quote(const std::string& s) {
  std::string out;
  char q = (char)39, bs = (char)92;
  out += q;
  for (unsigned char c : s) {
    if (c == 92 || c == 39) { out += bs; out += (char)c; }
    else if (c == 10) { out += bs; out += 'n'; }
    else if (c == 9) { out += bs; out += 't'; }
    else if (c == 13) { out += bs; out += 'r'; }
    else out += (char)c;
  }
  out += q;
  return out;
}
static std::string tsn_inspect(double v) { return tsn_num_to_string(v); }
static std::string tsn_inspect(long long v) { return std::to_string(v); }
static std::string tsn_inspect(bool b) { return b ? "true" : "false"; }
static std::string tsn_inspect(const tsn_str& s) { return tsn_quote(s.str()); }
// Forward declaration so the per-struct/class inspects (generated) can print
// array fields; the definition below resolves scalar elements by ordinary
// lookup and object/class elements by ADL at instantiation.
template <class T>
static std::string tsn_inspect(const std::shared_ptr<std::vector<T>>& a);

template <class T>
static std::string tsn_inspect(const std::shared_ptr<std::vector<T>>& a) {
  if (!a || a->empty()) return "[]";
  std::string out = "[ ";
  for (std::size_t i = 0; i < a->size(); ++i) {
    if (i) out += ", ";
    out += tsn_inspect((*a)[i]);
  }
  out += " ]";
  return out;
}

// --- JSON (JSON.parse / JSON.stringify) ---------------------------------
//
// JSON.parse is `any` in TypeScript, but the tsn subset is statically typed, so
// codegen always knows the *target* type at the call site (from `as T` or the
// receiving annotation). The two halves below reflect that split:
//
//   - PARSE. A generic, program-INDEPENDENT recursive-descent parser turns a
//     string into a `tsn_json` value (a tagged union). The generated .cpp then
//     extracts the statically-typed C++ value out of that `tsn_json` (scalars via
//     the `tsn_json_as_*` accessors below, arrays/objects via inline lambdas) —
//     so the parser stays here and the per-type shaping is emitted per call.
//   - STRINGIFY. Like `tsn_inspect`, but JSON format (double-quoted keys/strings,
//     no spaces, `null` for NaN/Infinity, no class name). The scalar overloads +
//     array template live here; the per-object/class overloads are generated.
//
// There is no exception machinery in the subset, so a parse failure or a value
// that doesn't match the asserted type prints a message and exits non-zero
// (`tsn_json_fail`) — the closest analog to JS's uncaught `SyntaxError`.

[[noreturn]] static void tsn_json_fail(const std::string& msg) {
  std::cerr << "tsn: JSON: " << msg << "\n";
  std::exit(1);
}

// A parsed JSON value: a tagged union over the six JSON kinds. Objects keep their
// members in source order (a small vector, looked up by key) — JSON objects are
// small in practice, so a linear scan beats a map's overhead.
struct tsn_json {
  enum Kind { Null, Bool, Number, String, Array, Object } kind = Null;
  bool b = false;
  double num = 0;
  std::string str;                                    // String
  std::vector<tsn_json> arr;                          // Array
  std::vector<std::pair<std::string, tsn_json>> obj;  // Object (in order)

  const std::vector<tsn_json>& as_array() const {
    if (kind != Array) tsn_json_fail("expected an array");
    return arr;
  }
  const tsn_json& get(const std::string& key) const {
    if (kind != Object) tsn_json_fail("expected an object");
    for (const auto& kv : obj)
      if (kv.first == key) return kv.second;
    // JS would yield `undefined`; the subset has no undefined, so this is an error.
    tsn_json_fail("missing key '" + key + "'");
  }
};

// Scalar extractors used by generated JSON.parse code. Each enforces that the
// parsed value matches the statically-asserted type (a mismatch is a hard error,
// since there is no `any` to fall back to).
static double tsn_json_as_number(const tsn_json& j) {
  if (j.kind != tsn_json::Number) tsn_json_fail("expected a number");
  return j.num;
}
static bool tsn_json_as_bool(const tsn_json& j) {
  if (j.kind != tsn_json::Bool) tsn_json_fail("expected a boolean");
  return j.b;
}
static tsn_str tsn_json_as_string(const tsn_json& j) {
  if (j.kind != tsn_json::String) tsn_json_fail("expected a string");
  return tsn_str(j.str);
}

// Encode a Unicode code point as UTF-8 bytes (for `\uXXXX` escapes in strings).
static void tsn_json_append_utf8(std::string& out, unsigned cp) {
  if (cp <= 0x7F) {
    out += (char)cp;
  } else if (cp <= 0x7FF) {
    out += (char)(0xC0 | (cp >> 6));
    out += (char)(0x80 | (cp & 0x3F));
  } else if (cp <= 0xFFFF) {
    out += (char)(0xE0 | (cp >> 12));
    out += (char)(0x80 | ((cp >> 6) & 0x3F));
    out += (char)(0x80 | (cp & 0x3F));
  } else {
    out += (char)(0xF0 | (cp >> 18));
    out += (char)(0x80 | ((cp >> 12) & 0x3F));
    out += (char)(0x80 | ((cp >> 6) & 0x3F));
    out += (char)(0x80 | (cp & 0x3F));
  }
}

// A small recursive-descent JSON parser over a std::string. Standard JSON grammar:
// whitespace, null/true/false, numbers (int/frac/exp), strings (with `\` escapes
// incl. `\uXXXX` and surrogate pairs), arrays, and objects. Any malformed input
// calls tsn_json_fail (which exits) — matching an uncaught JS SyntaxError.
struct tsn_json_parser {
  const std::string& s;
  std::size_t i = 0;
  explicit tsn_json_parser(const std::string& src) : s(src) {}

  void skip_ws() {
    while (i < s.size()) {
      char c = s[i];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++i;
      else break;
    }
  }

  tsn_json parse() {
    skip_ws();
    tsn_json v = parse_value();
    skip_ws();
    if (i != s.size()) tsn_json_fail("unexpected trailing characters");
    return v;
  }

  tsn_json parse_value() {
    skip_ws();
    if (i >= s.size()) tsn_json_fail("unexpected end of input");
    char c = s[i];
    if (c == '{') return parse_object();
    if (c == '[') return parse_array();
    if (c == '"') {
      tsn_json v;
      v.kind = tsn_json::String;
      v.str = parse_string();
      return v;
    }
    if (c == 't' || c == 'f') return parse_bool();
    if (c == 'n') return parse_null();
    if (c == '-' || (c >= '0' && c <= '9')) return parse_number();
    tsn_json_fail("unexpected character");
  }

  unsigned parse_hex4() {
    if (i + 4 > s.size()) tsn_json_fail("bad \\u escape");
    unsigned v = 0;
    for (int k = 0; k < 4; ++k) {
      char c = s[i++];
      v <<= 4;
      if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
      else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
      else tsn_json_fail("bad \\u escape");
    }
    return v;
  }

  std::string parse_string() {
    ++i;  // consume opening quote
    std::string out;
    while (i < s.size()) {
      char c = s[i++];
      if (c == '"') return out;
      if (c == '\\') {
        if (i >= s.size()) tsn_json_fail("bad escape");
        char e = s[i++];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            unsigned cp = parse_hex4();
            if (cp >= 0xD800 && cp <= 0xDBFF) {  // high surrogate -> need a low one
              if (i + 1 < s.size() && s[i] == '\\' && s[i + 1] == 'u') {
                i += 2;
                unsigned lo = parse_hex4();
                if (lo < 0xDC00 || lo > 0xDFFF) tsn_json_fail("bad surrogate pair");
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
              } else {
                tsn_json_fail("bad surrogate pair");
              }
            }
            tsn_json_append_utf8(out, cp);
            break;
          }
          default: tsn_json_fail("bad escape");
        }
      } else {
        out += c;
      }
    }
    tsn_json_fail("unterminated string");
  }

  tsn_json parse_number() {
    std::size_t start = i;
    if (i < s.size() && s[i] == '-') ++i;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
    if (i < s.size() && s[i] == '.') {
      ++i;
      while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
    }
    if (i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
      ++i;
      if (i < s.size() && (s[i] == '+' || s[i] == '-')) ++i;
      while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
    }
    tsn_json v;
    v.kind = tsn_json::Number;
    v.num = std::strtod(s.substr(start, i - start).c_str(), nullptr);
    return v;
  }

  tsn_json parse_bool() {
    if (s.compare(i, 4, "true") == 0) {
      i += 4;
      tsn_json v;
      v.kind = tsn_json::Bool;
      v.b = true;
      return v;
    }
    if (s.compare(i, 5, "false") == 0) {
      i += 5;
      tsn_json v;
      v.kind = tsn_json::Bool;
      v.b = false;
      return v;
    }
    tsn_json_fail("invalid literal");
  }

  tsn_json parse_null() {
    if (s.compare(i, 4, "null") == 0) {
      i += 4;
      return tsn_json();  // Null
    }
    tsn_json_fail("invalid literal");
  }

  tsn_json parse_array() {
    ++i;  // consume '['
    tsn_json v;
    v.kind = tsn_json::Array;
    skip_ws();
    if (i < s.size() && s[i] == ']') { ++i; return v; }
    while (true) {
      v.arr.push_back(parse_value());
      skip_ws();
      if (i >= s.size()) tsn_json_fail("unterminated array");
      char c = s[i++];
      if (c == ']') return v;
      if (c != ',') tsn_json_fail("expected ',' or ']'");
    }
  }

  tsn_json parse_object() {
    ++i;  // consume '{'
    tsn_json v;
    v.kind = tsn_json::Object;
    skip_ws();
    if (i < s.size() && s[i] == '}') { ++i; return v; }
    while (true) {
      skip_ws();
      if (i >= s.size() || s[i] != '"') tsn_json_fail("expected object key");
      std::string key = parse_string();
      skip_ws();
      if (i >= s.size() || s[i] != ':') tsn_json_fail("expected ':'");
      ++i;
      v.obj.emplace_back(std::move(key), parse_value());
      skip_ws();
      if (i >= s.size()) tsn_json_fail("unterminated object");
      char c = s[i++];
      if (c == '}') return v;
      if (c != ',') tsn_json_fail("expected ',' or '}'");
    }
  }
};

static tsn_json tsn_json_parse(const std::string& s) {
  return tsn_json_parser(s).parse();
}

// JSON.stringify, JSON format: double-quoted keys and strings (with escapes), no
// spaces, `null` for non-finite numbers. The scalar overloads + array template
// are here; the per-object-struct / per-class overloads (which need field names)
// are generated into the .cpp, mirroring the tsn_inspect split (and resolved on
// array elements by ADL at the instantiation point, same as tsn_inspect).
static std::string tsn_json_quote(const std::string& s) {
  std::string out;
  out += '"';
  const char* hex = "0123456789abcdef";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += '\\'; out += '"'; break;
      case '\\': out += '\\'; out += '\\'; break;
      case '\b': out += '\\'; out += 'b'; break;
      case '\f': out += '\\'; out += 'f'; break;
      case '\n': out += '\\'; out += 'n'; break;
      case '\r': out += '\\'; out += 'r'; break;
      case '\t': out += '\\'; out += 't'; break;
      default:
        if (c < 0x20) {
          out += '\\'; out += 'u'; out += '0'; out += '0';
          out += hex[(c >> 4) & 0xF];
          out += hex[c & 0xF];
        } else {
          out += (char)c;
        }
    }
  }
  out += '"';
  return out;
}
static std::string tsn_json_stringify(double v) {
  if (!std::isfinite(v)) return "null";  // JSON has no NaN/Infinity
  return tsn_num_to_string(v);
}
static std::string tsn_json_stringify(long long v) { return std::to_string(v); }
static std::string tsn_json_stringify(bool b) { return b ? "true" : "false"; }
static std::string tsn_json_stringify(const tsn_str& s) { return tsn_json_quote(s.str()); }
template <class T>
static std::string tsn_json_stringify(const std::shared_ptr<std::vector<T>>& a);

template <class T>
static std::string tsn_json_stringify(const std::shared_ptr<std::vector<T>>& a) {
  if (!a) return "null";
  std::string out = "[";
  for (std::size_t i = 0; i < a->size(); ++i) {
    if (i) out += ",";
    out += tsn_json_stringify((*a)[i]);
  }
  out += "]";
  return out;
}
