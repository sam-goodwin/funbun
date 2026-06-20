#pragma once

#include "root.h"

#include <JavaScriptCore/Weak.h>
#include <JavaScriptCore/WeakInlines.h>
#include <JavaScriptCore/WeakHandleOwner.h>
#include <wtf/HashMap.h>

namespace Bun {

// Assigns a stable, process-unique id to each scope environment (a JSCell:
// JSLexicalEnvironment / JSModuleEnvironment). A captured variable's cell is
// identified as (environmentId, scopeOffset) — see Symbol.freeVariables. Two
// closures that close over the same variable share the same environment
// instance, so they observe the same id.
//
// GC-aware: WeakGCMap is weak on its *values*, which is the wrong polarity here
// (we need the environment *key* to be weak), so we register a Weak with a
// finalizer instead. When an environment is collected its entry is removed,
// which guarantees a freed-then-reused environment pointer never inherits a
// stale id.
class FreeVariableIdTable final : public JSC::WeakHandleOwner {
    WTF_DEPRECATED_MAKE_FAST_ALLOCATED(FreeVariableIdTable);

public:
    FreeVariableIdTable() = default;
    uint64_t idForEnvironment(JSC::JSCell* environment)
    {
        auto result = m_ids.add(environment, Entry {});
        if (result.isNewEntry) {
            result.iterator->value.id = ++m_nextId;
            result.iterator->value.weak = JSC::Weak<JSC::JSCell>(environment, this, environment);
        }
        return result.iterator->value.id;
    }

    void finalize(JSC::Handle<JSC::Unknown>, void* context) final
    {
        m_ids.remove(static_cast<JSC::JSCell*>(context));
    }

private:
    struct Entry {
        uint64_t id { 0 };
        JSC::Weak<JSC::JSCell> weak;
    };

    UncheckedKeyHashMap<JSC::JSCell*, Entry> m_ids;
    uint64_t m_nextId { 0 };
};

} // namespace Bun
