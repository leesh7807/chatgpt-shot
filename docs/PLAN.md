# Plan Instructions

Create and maintain a plan that keeps the work aligned with the objective and makes completion easy to judge.

- Name each plan document using the format `date-summary`.

- Use the confirmed objective, intent, verification requirements, repository conventions, and available evidence to settle decisions that could change the outcome, externally observable behavior, contracts, responsibilities, boundaries, or verification. Include implementation details only when they are necessary to preserve one of those decisions or to make the intended work unambiguous.

- Treat Objective, Intent, and Verification Requirements together as the complete top-level contract of the plan. Any fact that materially changes what result is acceptable, what externally observable behavior or boundary must hold, what failure behavior is required, or whether the objective counts as achieved must be expressed within those sections rather than introduced later.

- Do not invent reasons, tradeoffs, or justifications for the user.

- Define verification in terms of observable evidence. The plan must make clear how the intended result will be demonstrated and what evidence is sufficient to establish each material Verification Requirement.

- Fix terminology before planning. Use one term for one meaning.

- Do not use the plan as an execution log.

- Keep active plans under `docs/plans/active/`. Before making a Pull Request, move the plan to `docs/plans/completed/`.

When reviewing the plan, check that each planned unit describes a coherent outcome in the problem domain rather than merely an implementation step.

Also check that verification demonstrates the material requirements through representative practical evidence. Use broader integration or end-to-end verification when the requirement depends materially on components, external effects, or authoritative outcomes working together.

A good planned unit should:

- Describe one meaningful responsibility or capability.

- Have a result that can be understood and verified on its own.

- Avoid combining unrelated responsibilities just to reduce the number of units.

Do not split the plan just to make the work easier for an agent.

If you cannot turn a planned unit into a clear executable issue, check whether you understand its scope and domain boundary well enough.

The final plan should resolve the decisions necessary to preserve the objective, intended behavior, contracts, responsibilities, boundaries, and verification requirements. Include implementation details only when they are necessary to carry those decisions into execution or when different choices could materially change the resulting contract, responsibility boundary, externally observable behavior, or verification claim. Leave ordinary engineering decisions to execution.

Write in Korean.

KISS, YANGI, DRY is core principle.

## Plan format

```
# date-summary

## Objective

Record the confirmed outcome the work must achieve and what the plan must stay aligned with.

Keep it focused on the intended result. Do not include implementation decisions, recovery mechanisms, or verification procedures here.

Do not modify this section unless the user explicitly changes or asks to revise it.

## Intent

Record the confirmed problem, motivation, or desired direction that explains why the objective exists and how the user intends the objective to be interpreted.

Preserve context that could materially change the meaning of success, failure, or acceptable behavior when implementation choices arise.

Do not repeat implementation decisions, mechanisms, detailed contracts, or verification procedures here.

Do not modify this section unless the user explicitly changes or asks to revise it.

## Verification Requirements

Record the confirmed facts, guarantees, or externally observable outcomes that must be demonstrated for the objective to count as achieved.

Together with `Objective` and `Intent`, this section must close the top-level contract. Do not rely on `Definitions`, `Decisions`, or `Verification` to introduce a material condition that changes whether the result is acceptable or whether the objective counts as achieved.

State what must be proven, not how to prove it.

Include requirements about the intended execution path, required external effects, failure behavior, authoritative outcomes, or boundaries when they materially affect whether the objective was actually achieved.

Do not prescribe a particular verification mechanism or test level unless that execution path or boundary is itself materially part of the requirement.

Do not replace these requirements with implementation-specific checks or alternative evidence that proves a materially different claim.

Do not modify this section unless the user explicitly changes or asks to revise it.

## Definitions

Define terms that are specific to the domain or repository, or that could reasonably be misunderstood.

## Decisions

Record only the decisions, assumptions, and defaults needed to preserve and carry out the objective, intent, contracts, responsibilities, boundaries, and verification requirements already established above.

Do not introduce here a new externally observable guarantee, success condition, failure condition, behavioral boundary, or authoritative outcome that is necessary to judge whether the objective was achieved. If such a condition is material, it belongs in `Verification Requirements`.

Under Decisions only, define protected scope and naming: identify existing behavior, responsibilities, or system areas that must remain unchanged, with any crossing change deferred to a separate plan; and require file, module, type, and major function names to expose their current responsibility and role without naming around abstractions that do not yet exist.

Do not carry these decisions into Objective, Intent, or Verification Requirements.

Prefer stating what must remain true. Include implementation details only when the mechanism itself is a necessary part of the decision; otherwise leave it to implementation.

Do not resolve implementation choices merely to make the plan more complete. Leave ordinary engineering decisions to execution unless different choices could materially change a contract, responsibility boundary, externally observable result, or verification claim.

Do not partially prescribe incidental implementation details or leave incomplete internal rules that appear contractual.

Include rationale, constraints, alternatives, or accepted tradeoffs only when they are needed to understand a recorded decision.

Do not repeat background already captured in Intent.

## Verification

Describe how each material Verification Requirement will be demonstrated through observable evidence.

This section defines only how the existing Verification Requirements will be demonstrated. It must not introduce, strengthen, narrow, or reinterpret the contract. If designing verification reveals a condition that materially changes what must be true for the objective to count as achieved, move that condition into `Verification Requirements`.

For each material Verification Requirement, make clear what observable evidence establishes that it passed or failed.

Prefer verification through the most representative practical path for the requirement being demonstrated.

Use integration or end-to-end verification when the requirement depends materially on the real entry point, orchestration, integrations, required external effects, or authoritative readback working together.

Use narrower verification when it can establish the same material claim without changing the meaning of what is being proven.

Do not silently substitute lower-level evidence that proves a materially different claim.

If a material Verification Requirement cannot be fully established, state exactly what cannot be demonstrated, why, what closest verification will be performed instead, and what material uncertainty remains.

When missing infrastructure, tooling, or observability prevents a material Verification Requirement from being sufficiently demonstrated, treat enabling that verification as part of the planned work when it is reasonably within the objective's boundary.

## Verification Tools

List the tools or mechanisms that can produce or observe the required evidence, and state briefly what each one can verify.
```