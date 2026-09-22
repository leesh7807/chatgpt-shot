# Plan Instructions

Create and maintain a plan that keeps the work aligned with the objective and makes completion easy to judge.

- Name each plan document using the format `date-summary`.

- Use the confirmed objective, intent, verification requirements, repository conventions, and available evidence to settle decisions that could change the outcome, externally observable behavior, contracts, responsibilities, boundaries, or verification. Include implementation details only when they are necessary to preserve one of those decisions or to make the intended work unambiguous.

- Treat Objective, Intent, and Verification Requirements together as the complete top-level contract of the plan. Any fact that materially changes what result is acceptable, what externally observable behavior or boundary must hold, what failure behavior is required, or whether the objective counts as achieved must be expressed within those sections rather than introduced later.

- Do not invent reasons, tradeoffs, or justifications for the user.

- Define verification in terms of observable evidence. The plan must make clear how to tell whether the intended result works through the intended path.

- Fix terminology before planning. Use one term for one meaning.

- Update the plan during execution only when new evidence changes an important assumption, decision, boundary, intent, verification requirement, or verification method.

- Do not use the plan as an execution log.

- Keep active plans under `docs/plans/active/`. Before making a Pull Request, move the plan to `docs/plans/completed/`.

When reviewing the plan, check that each planned unit describes a coherent outcome in the problem domain rather than merely an implementation step.

Also check that verification reaches the highest practical level of the real execution path, and that any material gap in end-to-end verification is explicit rather than silently replaced by lower-level tests.

A good planned unit should:

- describe one meaningful responsibility or capability;

- have a result that can be understood and verified on its own;

- avoid combining unrelated responsibilities just to reduce the number of units.

Do not split the plan just to make the work easier for an agent.

If you cannot turn a planned unit into a clear executable issue, check whether you understand its scope and domain boundary well enough.

The final plan should resolve the decisions necessary to preserve the objective, intended behavior, contracts, responsibilities, boundaries, and verification requirements. It should identify the implementation details that are necessary to carry those decisions into execution, without prescribing incidental implementation choices that can safely be left to the executor.

Write in Korean.

KISS, YANGI, DRY is core principle.

## Plan format

```markdown
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

Do not replace these requirements with lower-level tests, implementation-specific checks, or alternative evidence that proves a materially different claim.

Do not modify this section unless the user explicitly changes or asks to revise it.

## Definitions

Define terms that are specific to the domain or repository, or that could reasonably be misunderstood.

## Decisions

Record only the decisions, assumptions, and defaults needed to preserve and carry out the objective, intent, contracts, responsibilities, boundaries, and verification requirements already established above.

Do not introduce here a new externally observable guarantee, success condition, failure condition, behavioral boundary, or authoritative outcome that is necessary to judge whether the objective was achieved. If such a condition is material, it belongs in `Verification Requirements`

Under Decisions only, define protected scope and naming: identify existing behavior, responsibilities, or system areas that must remain unchanged, with any crossing change deferred to a separate plan; and require file, module, type, and major function names to expose their current responsibility and role without naming around abstractions that do not yet exist. Do not carry these decisions into Objective, Intent, or Verification Requirements.

Prefer stating what must remain true. Include implementation details only when the mechanism itself is a necessary part of the decision; otherwise leave it to implementation.

Do not partially prescribe incidental implementation details or leave incomplete internal rules that appear contractual.

Include rationale, constraints, alternatives, or accepted tradeoffs only when they are needed to understand a recorded decision.

Do not repeat background already captured in Intent.

## Verification

Describe how each material Verification Requirement will be demonstrated through the intended execution path and observable evidence.

This section defines only how the existing Verification Requirements will be demonstrated. It must not introduce, strengthen, narrow, or reinterpret the contract. If designing verification reveals a condition that materially changes what must be true for the objective to count as achieved, move that condition into `Verification Requirements`.

Prefer verification through a representative end-to-end flow that exercises the real entry point, orchestration, integrations, required external effects, and authoritative readback applicable to the objective.

For each material Verification Requirement, make clear what observable evidence establishes that it passed or failed.

Treat the inability to perform representative end-to-end verification as a planning problem, not merely a verification limitation, when it leaves the objective or a central guarantee unverified through the real execution path.

If meaningful end-to-end verification is not possible, state exactly what cannot be exercised, why, what closest verification will be performed instead, and what material risk remains unverified.

When missing infrastructure, tooling, or observability prevents representative end-to-end verification, treat enabling that verification as part of the planned work when it is reasonably within the objective's boundary.

## Verification Tools

List the tools or mechanisms that can produce or observe the required evidence, and state briefly what each one can verify.
```
