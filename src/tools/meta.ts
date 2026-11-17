/** Tools that manage the session itself: todos, questions, plans, subagents, skills. */
import type { TodoItem } from '../session/state.ts';
import { truncate } from '../ui/ansi.ts';
import type { AskQuestion, Tool, ToolResult } from './types.ts';
import { errorResult } from './types.ts';

interface TodoInput {
  todos: TodoItem[];
}

export function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '(no todos)';
  return todos
    .map((t) => {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
      return `${mark} ${t.content}`;
    })
    .join('\n');
}

export const todoWriteTool: Tool<TodoInput> = {
  name: 'TodoWrite',
  description:
    'Record or update your task list for multi-step work. Send the complete list every time. ' +
    'Keep exactly one item in_progress, and mark items completed as soon as they are done. Skip this for trivial tasks.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full, updated list',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What needs to be done' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string', description: 'Present-tense form, e.g. "Running tests"' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  isReadOnly: () => false,
  label: (input) => {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    const done = todos.filter((t) => t.status === 'completed').length;
    return `${done}/${todos.length} done`;
  },
  async execute(input, ctx): Promise<ToolResult> {
    const todos = (input.todos ?? []).filter((t) => t && typeof t.content === 'string' && t.content.trim());
    ctx.session.todos = todos.map((t) => ({ content: t.content.trim(), status: t.status ?? 'pending', activeForm: t.activeForm }));
    ctx.runtime?.todosChanged?.();
    const remaining = ctx.session.todos.filter((t) => t.status !== 'completed').length;
    return {
      content: `Todo list updated (${remaining} remaining). Continue with the current task.`,
      summary: renderTodos(ctx.session.todos),
    };
  },
};

interface AskInput {
  questions: AskQuestion[];
}

export const askUserTool: Tool<AskInput> = {
  name: 'AskUserQuestion',
  description:
    'Ask the user to choose between options when a decision is genuinely theirs and you cannot proceed sensibly without it. ' +
    'Provide 2-4 concrete options per question; the user can always type their own answer.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The full question' },
            header: { type: 'string', description: 'Very short label, e.g. "Database"' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, description: { type: 'string' } },
                required: ['label'],
              },
            },
            multiSelect: { type: 'boolean' },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
  // Models often send options as bare strings, or one question without the list around it.
  normalize(raw) {
    const list = Array.isArray(raw.questions) ? raw.questions : raw.questions && typeof raw.questions === 'object' ? [raw.questions] : raw.question ? [raw] : undefined;
    if (!list) return raw;
    const questions = list.map((q: unknown) => {
      if (!q || typeof q !== 'object' || Array.isArray(q)) return q;
      const question = q as Record<string, unknown>;
      if (!Array.isArray(question.options)) return question;
      return { ...question, options: question.options.map((o: unknown) => (typeof o === 'string' || typeof o === 'number' ? { label: String(o) } : o)) };
    });
    return { ...raw, questions };
  },
  isReadOnly: () => true,
  label: (input) => truncate(input.questions?.[0]?.question ?? '', 80),
  async execute(input, ctx): Promise<ToolResult> {
    const questions = (input.questions ?? []).filter((q) => q && q.question);
    if (questions.length === 0) return errorResult('Provide at least one question.');
    for (const q of questions) {
      // Models sometimes send options as bare strings.
      q.options = (q.options ?? []).map((o) => (typeof o === 'string' ? { label: o } : o)).filter((o) => o && o.label);
    }
    if (!ctx.runtime?.askUser) {
      return { content: 'No user is available to answer in this session. Make the most reasonable assumption, state it, and continue.' };
    }
    const answers = await ctx.runtime.askUser(questions, ctx.signal);
    if (!answers) return { content: 'The user dismissed the question without answering. Use your best judgment or ask in plain text.' };
    const lines = Object.entries(answers).map(([q, a]) => `Q: ${q}\nA: ${a}`);
    return { content: `The user answered:\n${lines.join('\n\n')}`, summary: Object.values(answers).join(' · ') };
  },
};

interface PlanInput {
  plan: string;
}

export const exitPlanModeTool: Tool<PlanInput> = {
  name: 'ExitPlanMode',
  description:
    'In plan mode, present your implementation plan for approval once you have finished researching. ' +
    'The plan should be concise Markdown: what will change, in which files, and how it will be verified.',
  parameters: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The plan, in Markdown' } },
    required: ['plan'],
  },
  isReadOnly: () => true,
  label: () => '',
  async execute(input, ctx): Promise<ToolResult> {
    if (!input.plan?.trim()) return errorResult('The plan is empty.');
    if (!ctx.runtime?.approvePlan) {
      return { content: 'Plan recorded. No user is available to approve it in this session, so stop here and present the plan as your final answer.', summary: 'Plan submitted' };
    }
    const res = await ctx.runtime.approvePlan(input.plan, ctx.signal);
    if (res.approved) {
      return { content: 'The user approved the plan. Plan mode is off: start implementing now, and track the steps with TodoWrite.', summary: 'Plan approved' };
    }
    return {
      content: `The user did not approve the plan.${res.feedback ? ` Their feedback: ${res.feedback}` : ''} Stay in plan mode, revise, and present it again.`,
      summary: 'Plan rejected',
    };
  },
};

export const enterPlanModeTool: Tool<Record<string, never>> = {
  name: 'EnterPlanMode',
  description:
    'Switch to plan mode before a large or risky change: you then research read-only and present a plan with ExitPlanMode for the user to approve.',
  parameters: { type: 'object', properties: {} },
  isReadOnly: () => true,
  label: () => '',
  async execute(_input, ctx): Promise<ToolResult> {
    if (!ctx.runtime?.enterPlanMode?.()) return errorResult('Plan mode is not available in this session. Continue with the task.');
    return {
      content: 'Plan mode is on. Investigate with read-only tools; nothing may be changed yet. When you know what to do, call ExitPlanMode with your plan.',
      summary: 'Entered plan mode',
    };
  },
};

interface AgentInput {
  description: string;
  prompt: string;
  subagent_type?: string;
}

export const agentTool: Tool<AgentInput> = {
  name: 'Agent',
  description:
    'Delegate a self-contained task to a subagent that works in its own context and returns a final report. ' +
    'Good for broad searches and research that would flood your context. The subagent knows nothing about this conversation: ' +
    'put everything it needs in the prompt.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short task title (3-5 words)' },
      prompt: { type: 'string', description: 'Complete instructions for the subagent' },
      subagent_type: { type: 'string', description: 'Which agent to use (default: general-purpose)' },
    },
    required: ['description', 'prompt'],
  },
  isReadOnly: () => true,
  // Lets rules such as Agent(explore) deny a particular subagent type.
  permission: (input) => ({ tool: 'Agent', kind: 'other', target: (input.subagent_type || 'general-purpose').trim(), description: `Run the ${input.subagent_type || 'general-purpose'} subagent` }),
  label: (input) => `${input.subagent_type ? `${input.subagent_type}: ` : ''}${truncate(input.description ?? '', 70)}`,
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.runtime) return errorResult('Subagents are not available in this session.');
    if (ctx.depth >= 1) return errorResult('Subagents cannot start further subagents. Do the work directly.');
    const types = ctx.runtime.agentTypes();
    const wanted = input.subagent_type?.trim() || 'general-purpose';
    // Models often write "Explore" for "explore": names compare without case.
    const type = types.find((t) => t.name.toLowerCase() === wanted.toLowerCase())?.name;
    if (!type) {
      return errorResult(`Unknown subagent_type "${wanted}". Available: ${types.map((t) => t.name).join(', ')}.`);
    }
    const res = await ctx.runtime.runSubagent({
      type,
      description: input.description,
      prompt: input.prompt,
      signal: ctx.signal,
      depth: ctx.depth + 1,
      onProgress: ctx.onProgress,
    });
    return {
      content: res.text || '(The subagent returned no text.)',
      isError: res.isError,
      summary: `Done (${res.toolUses} tool use${res.toolUses === 1 ? '' : 's'} · ${Math.round(res.tokens / 100) / 10}k tokens)`,
    };
  },
};

interface SkillInput {
  skill: string;
  args?: string;
}

export const skillTool: Tool<SkillInput> = {
  name: 'Skill',
  description: 'Load the instructions for a named skill. Use it when a listed skill matches the task, then follow what it says.',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Name of the skill' },
      args: { type: 'string', description: 'Optional arguments for the skill' },
    },
    required: ['skill'],
  },
  isReadOnly: () => true,
  // Lets rules such as Skill(deploy) or Skill(deploy *) deny a particular skill.
  permission: (input) => {
    const name = String(input.skill ?? '').replace(/^\//, '').trim();
    return { tool: 'Skill', kind: 'other', target: input.args?.trim() ? `${name} ${input.args.trim()}` : name, description: `Load the ${name} skill` };
  },
  label: (input) => input.skill,
  async execute(input, ctx): Promise<ToolResult> {
    const name = String(input.skill ?? '').replace(/^\//, '').trim();
    const skill = await ctx.runtime?.invokeSkill(name, input.args ?? '', 'model');
    if (!skill) {
      const names = ctx.runtime?.skills().map((s) => s.name) ?? [];
      return errorResult(`No skill named "${name}".${names.length ? ` Available: ${names.join(', ')}.` : ' No skills are installed.'}`);
    }
    // A skill marked `context: fork` does its work in a subagent and reports back.
    if (skill.forkAgent && ctx.runtime && ctx.depth < 1) {
      const res = await ctx.runtime.runSubagent({
        type: skill.forkAgent,
        description: `Skill ${skill.name}`,
        prompt: skill.content,
        signal: ctx.signal,
        depth: ctx.depth + 1,
        onProgress: ctx.onProgress,
      });
      return { content: res.text || '(The skill returned no text.)', isError: res.isError, summary: `Ran skill ${skill.name} in a subagent` };
    }
    return { content: skill.content, summary: `Loaded skill ${skill.name}` };
  },
};

/** How a skill's instructions are presented to the model. */
export function renderSkill(name: string, baseDir: string, body: string): string {
  return [`Skill "${name}" (files are in ${baseDir}):`, '', body.trim()].join('\n');
}
