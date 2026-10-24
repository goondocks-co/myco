# Existing package dispatcher fixture

npm-dispatch.cjs preserves the dispatch statements from
myco/v1.4.9:packages/myco/bin/myco.cjs. Comments and reinstall advice are omitted.
Tests supply the existing resolution and redirect companions and fake binaries.
It exercises a surviving installed dispatcher, not a distributed 2.x entry point.
