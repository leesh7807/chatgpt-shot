# Plan Instructions

Create and maintain a plan that keeps the work aligned with the objective and makes completion easy to judge.

- Name each plan document using the format `date-summary`.

- Use the confirmed objective, intent, repository conventions, and available evidence to settle decisions that could change the outcome.

- Do not invent reasons, tradeoffs, or justifications for the user.

- Define verification in terms of observable evidence. The plan must make clear how to tell whether the intended result works through the intended path.

- Fix terminology before planning. Use one term for one meaning.

- Update the plan during execution only when new evidence changes an important assumption, decision, boundary, intent, or verification method.

- Do not use the plan as an execution log.

- Keep active plans under `docs/plans/active/`. Before making a Pull Request, move the plan to `docs/plans/completed/`.

When reviewing the plan, check that each planned unit describes a coherent outcome in the problem domain rather than merely an implementation step.

A good planned unit should:

- describe one meaningful responsibility or capability;

- have a result that can be understood and verified on its own;

- avoid combining unrelated responsibilities just to reduce the number of units.

Do not split the plan just to make the work easier for an agent.

If you cannot turn a planned unit into a clear executable issue, check whether you understand its scope and domain boundary well enough.

The final plan should be complete enough for implementation to begin without unresolved planning decisions that could change the objective or its boundaries.

## Plan format

```markdown
# date-summary

## Objective

Describe the intended outcome and what the plan must stay aligned with.

## Definitions

Define terms that are specific to the domain or repository, or that could reasonably be misunderstood.

## Intent

Record the problem, motivation, or desired direction that explains why the objective exists and helps interpret it when implementation choices arise.

Preserve user-provided context when losing it could lead to a materially different implementation.

Do not repeat decisions or implementation requirements here.

## Decisions

Record the decisions, assumptions, and defaults that define the objective or its boundaries.

Include rationale, constraints, alternatives, or accepted tradeoffs only when they are needed to understand a recorded decision.

Do not repeat background already captured in Intent.

## Verification

Describe the observable evidence that will show whether the objective has been achieved through the intended execution path.

## Verification Tools

List the tools or mechanisms that can produce or observe the required evidence, and state briefly what each one can verify.
```