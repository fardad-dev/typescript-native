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

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <cmath>
#include <coroutine>
#include <cstdlib>
#include <deque>
#include <functional>
#include <iostream>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
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

// A non-atomic, ref-counted shared pointer — the representation for every
// aggregate REFERENCE type (arrays, object literals, class instances, Map/Set,
// Response). It is a drop-in for the subset of std::shared_ptr codegen uses
// (operator-> / operator* / operator bool / identity ==), but its refcount is a
// plain `long`, not an atomic, exactly like tsn_str above. Generated programs are
// single-threaded, so std::shared_ptr's atomic increment/decrement on every copy
// is pure overhead — and it dominates element-shuffling hot loops (e.g. an
// insertion sort's `a[j+1] = a[j]`, which copies the pointer once per step). A
// non-atomic refcount makes that copy as cheap as a value move, recovering ~7x on
// object/array-heavy code while keeping JS reference semantics (alias on copy,
// shared mutation, `===` identity). Like tsn_str, the box holds the value inline
// next to the count (one allocation, like std::make_shared).
template <class T>
struct tsn_rc {
  struct Box { long n; T v; };
  Box* b = nullptr;
  tsn_rc() = default;
  explicit tsn_rc(Box* x) noexcept : b(x) {}
  tsn_rc(const tsn_rc& o) noexcept : b(o.b) { if (b) ++b->n; }
  tsn_rc(tsn_rc&& o) noexcept : b(o.b) { o.b = nullptr; }
  tsn_rc& operator=(const tsn_rc& o) noexcept {
    if (o.b) ++o.b->n;
    if (b && --b->n == 0) delete b;
    b = o.b;
    return *this;
  }
  tsn_rc& operator=(tsn_rc&& o) noexcept {
    if (this != &o) { if (b && --b->n == 0) delete b; b = o.b; o.b = nullptr; }
    return *this;
  }
  ~tsn_rc() { if (b && --b->n == 0) delete b; }
  T* operator->() const noexcept { return &b->v; }
  T& operator*() const noexcept { return b->v; }
  explicit operator bool() const noexcept { return b != nullptr; }
  // Identity (pointer) equality — backs `===` / `!==` on reference types, so two
  // distinct literals with equal contents compare unequal (like std::shared_ptr).
  bool operator==(const tsn_rc& o) const noexcept { return b == o.b; }
  bool operator!=(const tsn_rc& o) const noexcept { return b != o.b; }
};
// Mirrors std::make_shared: one allocation holding the count + a freshly
// constructed T. Variadic-forwards to T's constructor (a class) or to C++20
// parenthesized aggregate init (an object/vector/Map/Set struct). Codegen usually
// passes a fully-built temporary (e.g. tsn_make_rc<tsn_Obj0>(tsn_Obj0{...})),
// which move-constructs into the box.
template <class T, class... A>
static tsn_rc<T> tsn_make_rc(A&&... a) {
  return tsn_rc<T>(new typename tsn_rc<T>::Box{1, T(std::forward<A>(a)...)});
}

// A heap cell holding one variable, used to back a CAPTURED local. A C++ lambda's
// default capture (`[=]`) copies the automatic variables it uses, which would give
// each closure its own snapshot — wrong for a JS closure that must share (and see
// later writes to) an enclosing local. So codegen boxes a captured local in a
// `tsn_rc<tsn_box<T>>`: the cell is one heap value, `[=]` copies the (shared) tsn_rc
// pointer, and every access goes through `->v`, so the enclosing scope and all its
// closures read and write one binding (`makeCounter`, shared mutable state, …).
template <class T>
struct tsn_box {
  T v;
};

// --- async / await: promises + the microtask event loop -----------------
//
// An `async function` compiles to a C++20 coroutine returning `tsn_promise<T>`
// (codegen emits `co_await` for `await` and `co_return` for `return`); `await`
// suspends the coroutine and schedules its continuation on a microtask queue.
// There are no timers / I/O in the subset, so the "event loop" is exactly that
// queue: `main()` runs the synchronous top-level, then drains it to fixpoint
// (every promise settles via synchronous computation, so the drain terminates).
//
// This reproduces V8's ordering precisely (verified byte-for-byte against Node):
//   - `initial_suspend` is `suspend_never`, so an async function runs
//     synchronously until its first `await` (then returns its pending promise);
//   - `await_ready` is ALWAYS false, so `await` defers the continuation by at
//     least one microtask tick even when the awaited promise is already settled
//     (the famous "await schedules a microtask" behavior);
//   - settling a promise schedules its waiters as microtasks (never resumes them
//     inline), so suspended awaiters resume in FIFO order after the current run.
// Rejection rides the subset's string-only exception model: a `throw` inside an
// async function rejects its promise with the string; `await`ing a rejected
// promise re-throws it (caught by an ordinary `try`/`catch`).

inline std::deque<std::function<void()>>& tsn_microtask_queue() {
  static std::deque<std::function<void()>> q;
  return q;
}
inline void tsn_enqueue_microtask(std::function<void()> f) {
  tsn_microtask_queue().push_back(std::move(f));
}
// Drain the microtask queue to empty. Called once from main() after the
// synchronous top-level; a microtask may enqueue more, which this keeps running.
inline void tsn_run_microtasks() {
  auto& q = tsn_microtask_queue();
  while (!q.empty()) {
    auto f = std::move(q.front());
    q.pop_front();
    f();
  }
}

// The value of a `Promise<void>` — the subset has no `undefined`, so a void
// promise resolves to this empty unit (an async `void` function `co_return`s it).
struct tsn_unit {};

// The `null` / `undefined` value types — empty tag structs so a union variant can
// discriminate them and `typeof` can tell them apart. Distinct from `tsn_unit`
// (the Promise<void> resolution), though `undefined` and unit both print
// "undefined". A union member, never used outside a `tsn_union`'s alternatives.
struct tsn_null {};
struct tsn_undefined {};
inline bool operator==(tsn_null, tsn_null) { return true; }
inline bool operator!=(tsn_null, tsn_null) { return false; }
inline bool operator==(tsn_undefined, tsn_undefined) { return true; }
inline bool operator!=(tsn_undefined, tsn_undefined) { return false; }

// A typed union `A | B | …` — a thin wrapper over `std::variant` so that (a) our
// `tsn_inspect`/`tsn_json_stringify`/`tsn_typeof` overloads are found by ADL even
// for an all-scalar union (e.g. `number | string`, whose alternatives are
// built-in types with no associated namespace of ours), and (b) member→union
// widening uses the inherited variant constructors. `.v()` exposes the base
// variant for `std::visit` / `std::get` / `std::holds_alternative`. Codegen orders
// the alternatives so `undefined`/`null` (if present) come first — the default
// alternative is then the JS-correct value for a `Map.get` miss on such a union.
template <class... Ts>
struct tsn_union : std::variant<Ts...> {
  using std::variant<Ts...>::variant;
  const std::variant<Ts...>& v() const { return *this; }
  std::variant<Ts...>& v() { return *this; }
};

// Widen a narrower union into a wider one (every alternative of the source is also
// an alternative of `Wider`): rebuild `Wider` around the active member. Used when a
// `A | B` value flows into a `A | B | C` slot — the C++ variant types differ, so a
// plain copy won't do.
template <class Wider, class... Ts>
static Wider tsn_union_widen(const tsn_union<Ts...>& u) {
  return std::visit(
      [](auto&& m) -> Wider {
        return Wider(std::in_place_type<std::decay_t<decltype(m)>>, m);
      },
      u.v());
}

// The shared, heap-allocated state behind a promise (a `tsn_promise<T>` is a
// thin handle to it, so copies alias — JS reference semantics, identity `===`).
// `value` outlives the coroutine frame that produced it (the frame self-destroys
// at final_suspend, but this shared_ptr is also held by the returned promise and
// any waiters), which is what makes the design memory-safe.
template <class T>
struct tsn_promise_state {
  int status = 0;  // 0 pending, 1 fulfilled, 2 rejected
  T value{};
  tsn_str reason;  // rejection reason (the subset throws strings)
  std::vector<std::coroutine_handle<>> waiters;
  void schedule_waiters() {
    if (waiters.empty()) return;
    std::vector<std::coroutine_handle<>> w;
    w.swap(waiters);
    for (auto h : w) tsn_enqueue_microtask([h]() { h.resume(); });
  }
  void fulfill(T v) {
    if (status) return;
    value = std::move(v);
    status = 1;
    schedule_waiters();
  }
  void reject(tsn_str e) {
    if (status) return;
    reason = std::move(e);
    status = 2;
    schedule_waiters();
  }
};

template <class T>
struct tsn_promise {
  std::shared_ptr<tsn_promise_state<T>> state;
  tsn_promise() : state(std::make_shared<tsn_promise_state<T>>()) {}
  explicit tsn_promise(std::shared_ptr<tsn_promise_state<T>> s) : state(std::move(s)) {}

  // The C++ coroutine return-object protocol: an async function returning
  // tsn_promise<T> uses this promise_type to drive the coroutine. (Note the name
  // clash with JS "promise" is unavoidable — this is C++'s coroutine vocabulary.)
  struct promise_type {
    std::shared_ptr<tsn_promise_state<T>> state =
        std::make_shared<tsn_promise_state<T>>();
    tsn_promise get_return_object() { return tsn_promise(state); }
    std::suspend_never initial_suspend() noexcept { return {}; }
    std::suspend_never final_suspend() noexcept { return {}; }
    void return_value(T v) { state->fulfill(std::move(v)); }
    void unhandled_exception() {
      // An async function never throws synchronously — a thrown value rejects its
      // promise instead. The subset throws only strings (see emit.ts `throw`).
      try {
        throw;
      } catch (const tsn_str& e) {
        state->reject(e);
      } catch (...) {
        state->reject(tsn_str("uncaught exception"));
      }
    }
  };

  // The awaiter protocol: a tsn_promise<T> is itself awaitable. await_ready is
  // always false so the continuation always defers by >=1 microtask tick.
  bool await_ready() const noexcept { return false; }
  void await_suspend(std::coroutine_handle<> h) const {
    if (state->status == 0) state->waiters.push_back(h);  // resume when settled
    else tsn_enqueue_microtask([h]() { h.resume(); });    // settled: one tick
  }
  T await_resume() const {
    if (state->status == 2) throw state->reason;  // rejection -> thrown tsn_str
    return state->value;
  }
};

// `Promise.resolve(v)` for a non-promise `v` (codegen passes a promise argument
// through unchanged): a promise already fulfilled with `v`.
template <class T>
static tsn_promise<T> tsn_resolve(T v) {
  tsn_promise<T> p;
  p.state->fulfill(std::move(v));
  return p;
}

// A promise already *rejected* with `reason` (used by `fetch` on a transport
// error). Like `tsn_resolve` but settles to status 2, so `await`ing it re-throws
// the reason string — catchable by an ordinary `try`/`catch`.
template <class T>
static tsn_promise<T> tsn_reject(tsn_str reason) {
  tsn_promise<T> p;
  p.state->reject(std::move(reason));
  return p;
}

// `Promise.all(ps)`: itself a coroutine that awaits each input promise in order
// and resolves to an array of the results (rejecting if any input rejects). The
// inputs already run concurrently (an async function starts when called), so the
// in-order await still collects every result; the result array is in input order.
template <class T>
static tsn_promise<tsn_rc<std::vector<T>>> tsn_all(
    tsn_rc<std::vector<tsn_promise<T>>> ps) {
  auto out = tsn_make_rc<std::vector<T>>();
  for (auto& p : *ps) out->push_back(co_await p);
  co_return out;
}

// --- fetch: a blocking HTTP GET behind a Promise<Response> ---------------
//
// The microtask runtime has no async I/O, so `fetch(url)` does a *blocking*
// libcurl GET and returns an already-settled promise. `await fetch(url)` still
// defers one microtask tick (await_ready is always false), so JS ordering holds.
// A `Response` is a reference type (tsn_rc<tsn_response>): `status`/`ok`
// fields plus a buffered `body`; `text()`/`json()` (emitted by codegen) return
// already-resolved promises over `body`. The struct itself is unconditional (it
// only uses tsn_str), so a function signature mentioning `Response` compiles even
// in a program that links without libcurl; only `tsn_fetch` needs curl.
struct tsn_response {
  double status;  // HTTP status code (f64, like every number field)
  bool ok;        // status in 200..=299
  tsn_str body;   // the response body, read eagerly
};

#ifdef TSN_ENABLE_FETCH
#include <curl/curl.h>

// libcurl write callback: append received bytes to the std::string body buffer.
static size_t tsn_fetch_write(char* ptr, size_t size, size_t nmemb, void* ud) {
  static_cast<std::string*>(ud)->append(ptr, size * nmemb);
  return size * nmemb;
}

// `fetch(url)` — a blocking HTTP(S) GET, returning an already-settled
// Promise<Response>. A transport error (DNS failure, connection refused, timeout,
// …) *rejects* the promise (so `await` throws the reason string, catchable with
// try/catch); an HTTP error *status* (404/500) is not a failure — it resolves with
// `ok === false`, matching real `fetch`.
static tsn_promise<tsn_rc<tsn_response>> tsn_fetch(const tsn_str& url) {
  static bool inited = false;  // single-threaded, so a plain guard is fine
  if (!inited) { curl_global_init(CURL_GLOBAL_DEFAULT); inited = true; }
  CURL* curl = curl_easy_init();
  if (!curl) {
    return tsn_reject<tsn_rc<tsn_response>>(
        tsn_str("fetch failed: could not initialize libcurl"));
  }
  std::string body;
  curl_easy_setopt(curl, CURLOPT_URL, url.str().c_str());
  curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, tsn_fetch_write);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
  CURLcode rc = curl_easy_perform(curl);
  if (rc != CURLE_OK) {
    tsn_str reason =
        tsn_str(std::string("fetch failed: ") + curl_easy_strerror(rc));
    curl_easy_cleanup(curl);
    return tsn_reject<tsn_rc<tsn_response>>(reason);
  }
  long code = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
  curl_easy_cleanup(curl);
  auto resp = tsn_make_rc<tsn_response>();
  resp->status = (double)code;
  resp->ok = code >= 200 && code <= 299;
  resp->body = tsn_str(std::move(body));
  return tsn_resolve<tsn_rc<tsn_response>>(resp);
}
#endif  // TSN_ENABLE_FETCH

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
template <class T> static inline bool tsn_truthy(const tsn_rc<T>& p) { return (bool)p; }
// A function value (closure) is always truthy (every live function is).
template <class R, class... A> static inline bool tsn_truthy(const std::function<R(A...)>& f) { return (bool)f; }
static inline bool tsn_truthy(tsn_null) { return false; }
static inline bool tsn_truthy(tsn_undefined) { return false; }
// A union is truthy iff its active member is (JS — null/undefined/0/NaN/"" falsy).
template <class... Ts>
static inline bool tsn_truthy(const tsn_union<Ts...>& u) {
  return std::visit([](auto&& m) { return tsn_truthy(m); }, u.v());
}

// `typeof` of one (already-extracted) value — the JS string for each member type.
// Note the JS quirk: `typeof null === "object"`; every reference type is "object".
static inline tsn_str tsn_typeof_one(double) { return tsn_str("number"); }
static inline tsn_str tsn_typeof_one(long long) { return tsn_str("number"); }
static inline tsn_str tsn_typeof_one(bool) { return tsn_str("boolean"); }
static inline tsn_str tsn_typeof_one(const tsn_str&) { return tsn_str("string"); }
static inline tsn_str tsn_typeof_one(tsn_null) { return tsn_str("object"); }
static inline tsn_str tsn_typeof_one(tsn_undefined) { return tsn_str("undefined"); }
template <class T>
static inline tsn_str tsn_typeof_one(const tsn_rc<T>&) { return tsn_str("object"); }
// `typeof aFunction === "function"`.
template <class R, class... A>
static inline tsn_str tsn_typeof_one(const std::function<R(A...)>&) { return tsn_str("function"); }
// `typeof` of a union — decided at runtime by the active variant.
template <class... Ts>
static inline tsn_str tsn_typeof(const tsn_union<Ts...>& u) {
  return std::visit([](auto&& m) { return tsn_typeof_one(m); }, u.v());
}

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

// JS String.prototype.includes / startsWith / endsWith — substring membership
// and prefix/suffix tests (string searches only; regex is out of subset).
static bool tsn_str_includes(const std::string& s, const std::string& sub, double fromD) {
  long long from = std::isnan(fromD) ? 0 : (long long)fromD;
  if (from < 0) from = 0;
  if (from > (long long)s.size()) return sub.empty();
  return s.find(sub, (std::size_t)from) != std::string::npos;
}
static bool tsn_starts_with(const std::string& s, const std::string& sub, double posD) {
  long long pos = std::isnan(posD) ? 0 : (long long)posD;
  if (pos < 0) pos = 0;
  if (pos + (long long)sub.size() > (long long)s.size()) return false;
  return s.compare((std::size_t)pos, sub.size(), sub) == 0;
}
static bool tsn_ends_with(const std::string& s, const std::string& sub, double endD) {
  long long end = std::isnan(endD) ? (long long)s.size() : (long long)endD;
  if (end < 0) end = 0;
  if (end > (long long)s.size()) end = (long long)s.size();
  if ((long long)sub.size() > end) return false;
  return s.compare((std::size_t)(end - (long long)sub.size()), sub.size(), sub) == 0;
}

// JS String.prototype.lastIndexOf: last position of `sub` at/before fromIndex
// (NaN = end). Returns -1 if absent.
static double tsn_last_index_of(const std::string& s, const std::string& sub, double fromD) {
  std::size_t from = std::isnan(fromD) ? std::string::npos
                   : (fromD < 0 ? 0 : (std::size_t)fromD);
  std::size_t pos = s.rfind(sub, from);
  return pos == std::string::npos ? -1.0 : (double)pos;
}

// JS String.prototype.repeat. JS throws RangeError on a negative / non-finite
// count; the subset has no exceptions, so the count is truncated toward zero and
// a count <= 0 (or NaN) yields the empty string.
static tsn_str tsn_repeat(const std::string& s, double countD) {
  if (std::isnan(countD) || countD <= 0.0) return std::string();
  long long count = (long long)countD;
  std::string out;
  out.reserve(s.size() * (std::size_t)count);
  for (long long i = 0; i < count; ++i) out += s;
  return out;
}

// JS String.prototype.trim / trimStart / trimEnd — strip leading/trailing ASCII
// whitespace. (JS also trims some Unicode spaces / BOM; ASCII covers the subset.)
static bool tsn_is_ws(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f';
}
static tsn_str tsn_trim_start(const std::string& s) {
  std::size_t i = 0;
  while (i < s.size() && tsn_is_ws(s[i])) ++i;
  return s.substr(i);
}
static tsn_str tsn_trim_end(const std::string& s) {
  std::size_t n = s.size();
  while (n > 0 && tsn_is_ws(s[n - 1])) --n;
  return s.substr(0, n);
}
static tsn_str tsn_trim(const std::string& s) {
  std::size_t i = 0, n = s.size();
  while (i < n && tsn_is_ws(s[i])) ++i;
  while (n > i && tsn_is_ws(s[n - 1])) --n;
  return s.substr(i, n - i);
}

// JS String.prototype.padStart / padEnd: pad with `pad` (repeated, then
// truncated) until the length reaches `target`. A target <= the current length,
// or an empty pad, returns the string unchanged.
static tsn_str tsn_pad_start(const std::string& s, double targetD, const std::string& pad) {
  long long target = std::isnan(targetD) ? 0 : (long long)targetD;
  if (target <= (long long)s.size() || pad.empty()) return s;
  std::size_t need = (std::size_t)target - s.size();
  std::string fill;
  while (fill.size() < need) fill += pad;
  fill.resize(need);
  return fill + s;
}
static tsn_str tsn_pad_end(const std::string& s, double targetD, const std::string& pad) {
  long long target = std::isnan(targetD) ? 0 : (long long)targetD;
  if (target <= (long long)s.size() || pad.empty()) return s;
  std::size_t need = (std::size_t)target - s.size();
  std::string fill;
  while (fill.size() < need) fill += pad;
  fill.resize(need);
  return s + fill;
}

// JS String.prototype.replace with a STRING search (regex is out of subset):
// replaces only the FIRST occurrence. The replacement is literal — JS's `$&` /
// `$1` substitution patterns are not expanded. An empty search matches at index 0.
static tsn_str tsn_replace(const std::string& s, const std::string& search, const std::string& repl) {
  if (search.empty()) return repl + s;
  std::size_t pos = s.find(search);
  if (pos == std::string::npos) return s;
  return s.substr(0, pos) + repl + s.substr(pos + search.size());
}
// JS String.prototype.replaceAll: every non-overlapping occurrence. An empty
// search inserts the replacement between every character (and at both ends),
// matching JS (`"ab".replaceAll("", "-") === "-a-b-"`).
static tsn_str tsn_replace_all(const std::string& s, const std::string& search, const std::string& repl) {
  if (search.empty()) {
    std::string out = repl;
    for (char c : s) { out += c; out += repl; }
    return out;
  }
  std::string out;
  std::size_t start = 0;
  while (true) {
    std::size_t pos = s.find(search, start);
    if (pos == std::string::npos) { out += s.substr(start); break; }
    out += s.substr(start, pos - start);
    out += repl;
    start = pos + search.size();
  }
  return out;
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

// JS Array.prototype.includes: membership test via operator== (so number NaN
// won't match NaN — a minor divergence from JS's SameValueZero). fromIndex
// (NaN = 0) may be negative (counts from the end).
template <class T>
static bool tsn_array_includes(const std::vector<T>& v, const T& x, double fromD) {
  long long len = (long long)v.size();
  long long from = std::isnan(fromD) ? 0 : (long long)fromD;
  if (from < 0) { from = len + from; if (from < 0) from = 0; }
  for (long long i = from; i < len; ++i)
    if (v[(std::size_t)i] == x) return true;
  return false;
}

// JS Array.prototype.lastIndexOf: last index where the element == x, searching
// backward from fromIndex (NaN = last). Negative fromIndex counts from the end.
template <class T>
static double tsn_array_last_index_of(const std::vector<T>& v, const T& x, double fromD) {
  long long len = (long long)v.size();
  long long from = std::isnan(fromD) ? len - 1 : (long long)fromD;
  if (from < 0) from = len + from;
  if (from >= len) from = len - 1;
  for (long long i = from; i >= 0; --i)
    if (v[(std::size_t)i] == x) return (double)i;
  return -1.0;
}

// JS Array.prototype.reverse: reverse in place. Codegen returns the array
// reference (the same tsn_rc) so `a.reverse()` can be chained / used as a value.
template <class T>
static void tsn_array_reverse(std::vector<T>& v) {
  std::reverse(v.begin(), v.end());
}

// JS Array.prototype.fill: set [start, end) to x in place. Negatives count from
// the end; an omitted (NaN) start/end defaults to 0 / length. Codegen returns the
// array reference.
template <class T>
static void tsn_array_fill(std::vector<T>& v, const T& x, double startD, double endD) {
  long long len = (long long)v.size();
  long long start = std::isnan(startD) ? 0 : (long long)startD;
  long long end = std::isnan(endD) ? len : (long long)endD;
  if (start < 0) start = len + start;
  if (end < 0) end = len + end;
  if (start < 0) start = 0;
  if (end < 0) end = 0;
  if (start > len) start = len;
  if (end > len) end = len;
  for (long long i = start; i < end; ++i) v[(std::size_t)i] = x;
}

// JS Array.prototype.concat (array operands): a new vector = a then b. Codegen
// folds a multi-argument concat into nested calls and wraps the result in a fresh
// tsn_rc (a shallow copy with a new identity, matching JS).
template <class T>
static std::vector<T> tsn_array_concat(const std::vector<T>& a, const std::vector<T>& b) {
  std::vector<T> out;
  out.reserve(a.size() + b.size());
  out.insert(out.end(), a.begin(), a.end());
  out.insert(out.end(), b.begin(), b.end());
  return out;
}

// JS Array.prototype.shift: remove and return the first element. Like pop, an
// empty array yields the element type's default (the subset has no `undefined`).
template <class T>
static T tsn_array_shift(std::vector<T>& v) {
  if (v.empty()) return T();
  T x = std::move(v.front());
  v.erase(v.begin());
  return x;
}

// JS Array.prototype.unshift: prepend `items` (in order) and return the new
// length. Codegen passes the arguments as a small vector so 0..n args work.
template <class T>
static double tsn_array_unshift(std::vector<T>& v, std::vector<T> items) {
  v.insert(v.begin(), items.begin(), items.end());
  return (double)v.size();
}

// --- Math.* helpers (only where JS diverges from <cmath>) ----------------
//
// Most Math functions map straight to <cmath> in generated code; these cover the
// cases where JS semantics differ. Every argument is already a double at the call
// site (codegen casts), and every result is a JS `number` (f64).

// JS Math.round rounds half toward +Infinity (Math.round(-2.5) === -2), unlike
// std::round (half away from zero). floor(x + 0.5) gives the JS rule; NaN and
// ±Infinity pass straight through (floor of them is themselves).
static inline double tsn_math_round(double x) {
  if (std::isnan(x) || std::isinf(x)) return x;
  return std::floor(x + 0.5);
}

// JS Math.sign: 1 / -1 for positive / negative, the (signed) zero for ±0, and
// NaN for NaN. <cmath> has no sign function.
static inline double tsn_math_sign(double x) {
  if (std::isnan(x)) return x;
  if (x > 0.0) return 1.0;
  if (x < 0.0) return -1.0;
  return x;  // preserves +0 / -0
}

// JS Math.min / Math.max: if ANY argument is NaN the result is NaN (std::fmin /
// std::fmax would skip a NaN). Codegen folds the variadic argument list with
// these binary helpers (Math.min() / Math.max() with no args -> ±Infinity).
static inline double tsn_math_min(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  return a < b ? a : b;
}
static inline double tsn_math_max(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return NAN;
  return a > b ? a : b;
}

// Math.random(): a double in [0, 1). Uses the C library PRNG (unseeded, so the
// sequence is deterministic across runs) — adequate for a learning compiler, and
// unlike JS there is no cryptographic guarantee.
static inline double tsn_math_random() {
  return (double)std::rand() / ((double)RAND_MAX + 1.0);
}

// --- Map / Set ----------------------------------------------------------
//
// JS Map and Set are *insertion-ordered* and compare keys/elements by
// SameValueZero (≈ identity for objects, value for primitives). These model that
// with a plain ordered vector and linear lookup using the same `operator==` the
// arrays use (so tsn_str compares by value, numbers by value, tsn_rc objects
// by identity). Linear scan is O(n) per op — clarity over a hashed structure, in
// keeping with this learning compiler. Both are held behind a tsn_rc in
// generated code, so they are reference types (alias, shared mutation, identity
// `===`). Subset divergences: a NaN number key won't match (operator== semantics),
// and a missing `get` yields the value type's default (there is no `undefined`).

template <class K, class V>
struct tsn_map {
  std::vector<std::pair<K, V>> entries;  // insertion order
  std::size_t size() const { return entries.size(); }
  std::size_t find(const K& k) const {
    for (std::size_t i = 0; i < entries.size(); ++i)
      if (entries[i].first == k) return i;
    return (std::size_t)-1;
  }
  bool has(const K& k) const { return find(k) != (std::size_t)-1; }
  void set(const K& k, const V& v) {
    std::size_t i = find(k);
    if (i == (std::size_t)-1) entries.emplace_back(k, v);
    else entries[i].second = v;
  }
  // JS Map.get returns `undefined` for a missing key; the subset has no
  // `undefined`, so a miss yields the value type's default (0 / "" / false / null).
  V get(const K& k) const {
    std::size_t i = find(k);
    return i == (std::size_t)-1 ? V() : entries[i].second;
  }
  bool del(const K& k) {
    std::size_t i = find(k);
    if (i == (std::size_t)-1) return false;
    entries.erase(entries.begin() + i);
    return true;
  }
  void clear() { entries.clear(); }
  tsn_rc<std::vector<K>> keys() const {
    auto out = tsn_make_rc<std::vector<K>>();
    for (const auto& kv : entries) out->push_back(kv.first);
    return out;
  }
  tsn_rc<std::vector<V>> values() const {
    auto out = tsn_make_rc<std::vector<V>>();
    for (const auto& kv : entries) out->push_back(kv.second);
    return out;
  }
};

template <class T>
struct tsn_set {
  std::vector<T> items;  // insertion order, unique by ==
  tsn_set() {}
  tsn_set(const std::vector<T>& v) { for (const T& x : v) add(x); }
  std::size_t size() const { return items.size(); }
  std::size_t find(const T& x) const {
    for (std::size_t i = 0; i < items.size(); ++i)
      if (items[i] == x) return i;
    return (std::size_t)-1;
  }
  bool has(const T& x) const { return find(x) != (std::size_t)-1; }
  void add(const T& x) { if (!has(x)) items.push_back(x); }
  bool del(const T& x) {
    std::size_t i = find(x);
    if (i == (std::size_t)-1) return false;
    items.erase(items.begin() + i);
    return true;
  }
  void clear() { items.clear(); }
  const T& at(std::size_t i) const { return items[i]; }
  // Set.keys() and Set.values() are both the elements in insertion order.
  tsn_rc<std::vector<T>> values() const {
    return tsn_make_rc<std::vector<T>>(items);
  }
};

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
static std::string tsn_inspect(tsn_null) { return "null"; }
static std::string tsn_inspect(tsn_undefined) { return "undefined"; }
// Forward declaration so the per-struct/class inspects (generated) can print
// array fields; the definition below resolves scalar elements by ordinary
// lookup and object/class elements by ADL at instantiation.
template <class T>
static std::string tsn_inspect(const tsn_rc<std::vector<T>>& a);
// Forward declaration of the function-value overload (defined below) so the array /
// map / set inspect templates can print a function-valued element (it isn't found
// by ADL — `std::function`'s namespace is `std`).
template <class R, class... A>
static std::string tsn_inspect(const std::function<R(A...)>&);
// A union prints its active member (resolved at runtime via std::visit); element
// overloads (incl. generated object/class ones) resolve by ADL at instantiation.
template <class... Ts>
static std::string tsn_inspect(const tsn_union<Ts...>& u) {
  return std::visit([](auto&& m) { return tsn_inspect(m); }, u.v());
}

// Top-level `console.log` of a union: the active member is printed exactly as a
// top-level console.log argument would be — a *string* bare (no surrounding
// quotes), everything else via the nested `tsn_inspect` (so a string *inside* a
// logged object is still quoted). Mirrors the `log`-statement scalar special-case.
template <class... Ts>
static std::string tsn_console_union(const tsn_union<Ts...>& u) {
  return std::visit(
      [](auto&& m) -> std::string {
        if constexpr (std::is_same_v<std::decay_t<decltype(m)>, tsn_str>)
          return m.str();
        else
          return tsn_inspect(m);
      },
      u.v());
}

template <class T>
static std::string tsn_inspect(const tsn_rc<std::vector<T>>& a) {
  if (!a || a->empty()) return "[]";
  std::string out = "[ ";
  for (std::size_t i = 0; i < a->size(); ++i) {
    if (i) out += ", ";
    out += tsn_inspect((*a)[i]);
  }
  out += " ]";
  return out;
}

// A Promise<void> value prints as `undefined` when nested (e.g. `[ undefined ]`).
static std::string tsn_inspect(tsn_unit) { return "undefined"; }

// A function value. Node prints `[Function: name]` / `[Function (anonymous)]`; the
// subset doesn't track the binding name, so every function value prints anonymous.
template <class R, class... A>
static std::string tsn_inspect(const std::function<R(A...)>&) {
  return "[Function (anonymous)]";
}

// A fetched Response: print its status/ok (Node prints a much richer object; this
// keeps `console.log(res)` compiling and informative on the subset).
static std::string tsn_inspect(const tsn_rc<tsn_response>& r) {
  if (!r) return "undefined";
  return "Response { status: " + tsn_num_to_string(r->status) +
         ", ok: " + (r->ok ? "true" : "false") + " }";
}

// Promise printing, best-effort toward Node: `Promise { <pending> }`,
// `Promise { 5 }` (fulfilled), `Promise { <rejected> }`. The fulfilled value
// recurses through tsn_inspect (object/class values resolve via ADL, like arrays).
template <class T>
static std::string tsn_inspect(const tsn_promise<T>& p) {
  if (!p.state || p.state->status == 0) return "Promise { <pending> }";
  if (p.state->status == 2) return "Promise { <rejected> }";
  return "Promise { " + tsn_inspect(p.state->value) + " }";
}

// Map / Set printing, matching Node: `Map(2) { 'a' => 1, 'b' => 2 }`,
// `Set(3) { 1, 2, 3 }` (empty: `Map(0) {}` / `Set(0) {}`). Keys/values/elements
// recurse through tsn_inspect (object/class elements resolve via ADL, like arrays).
template <class K, class V>
static std::string tsn_inspect(const tsn_rc<tsn_map<K, V>>& m) {
  std::size_t n = m ? m->entries.size() : 0;
  std::string out = "Map(" + std::to_string(n) + ")";
  if (n == 0) return out + " {}";
  out += " { ";
  for (std::size_t i = 0; i < n; ++i) {
    if (i) out += ", ";
    out += tsn_inspect(m->entries[i].first);
    out += " => ";
    out += tsn_inspect(m->entries[i].second);
  }
  out += " }";
  return out;
}
template <class T>
static std::string tsn_inspect(const tsn_rc<tsn_set<T>>& s) {
  std::size_t n = s ? s->items.size() : 0;
  std::string out = "Set(" + std::to_string(n) + ")";
  if (n == 0) return out + " {}";
  out += " { ";
  for (std::size_t i = 0; i < n; ++i) {
    if (i) out += ", ";
    out += tsn_inspect(s->items[i]);
  }
  out += " }";
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
// `null` → "null". `undefined` → "null" too: JSON has no undefined, and that's how
// JS serializes an undefined *array element* (a top-level `JSON.stringify(undefined)`
// is `undefined` in JS, which a string-returning subset can't represent).
static std::string tsn_json_stringify(tsn_null) { return "null"; }
static std::string tsn_json_stringify(tsn_undefined) { return "null"; }
template <class T>
static std::string tsn_json_stringify(const tsn_rc<std::vector<T>>& a);
// A function value has no JSON form. JS *omits* a function-valued object property
// and yields `undefined` at top level; the subset can't omit a key once emitted, so
// a function field serializes as `null` (a direct JSON.stringify of a function is a
// clean `tsnc:` error — see emit.ts). A documented edge-case divergence.
template <class R, class... A>
static std::string tsn_json_stringify(const std::function<R(A...)>&) { return "null"; }
// A union serializes its active member (resolved at runtime).
template <class... Ts>
static std::string tsn_json_stringify(const tsn_union<Ts...>& u) {
  return std::visit([](auto&& m) { return tsn_json_stringify(m); }, u.v());
}

template <class T>
static std::string tsn_json_stringify(const tsn_rc<std::vector<T>>& a) {
  if (!a) return "null";
  std::string out = "[";
  for (std::size_t i = 0; i < a->size(); ++i) {
    if (i) out += ",";
    out += tsn_json_stringify((*a)[i]);
  }
  out += "]";
  return out;
}
