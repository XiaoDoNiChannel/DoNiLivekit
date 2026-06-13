# Feature modules

Feature modules contain business logic and integration code. Keep UI-only changes in `components/` and shared utilities in `shared/`.

When adding a feature module, expose a factory such as `createXFeature(context)`. This keeps dependencies explicit and makes it clear which module owns which side effects.
