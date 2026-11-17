import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolSpecTokens } from '../src/agent/tokens.ts';
import {
  DEFAULT_DEFER_THRESHOLD_PERCENT,
  deferredListing,
  planDeferral,
  toolSearchThreshold,
  toolSearchTool,
  type DeferralState,
} from '../src/tools/toolSearch.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { makeContext, tempProject } from './helpers.ts';

function fake(name: string, description = `Does ${name}`): Tool {
  return {
    name,
    description,
    parameters: { type: 'object', properties: { input: { type: 'string', description: 'What to work on' } } },
    isReadOnly: () => true,
    execute: async () => ({ content: name }),
  };
}

function names(tools: Tool[]): string[] {
  return tools.map((t) => t.name);
}

function freshState(...loaded: string[]): DeferralState {
  return { loaded: new Set(loaded) };
}

let sharedCtx: ToolContext | undefined;
function ctx(): ToolContext {
  sharedCtx ??= makeContext(tempProject());
  return sharedCtx;
}

const BUILTINS = [fake('Read'), fake('Bash'), fake('Edit')];
const MCP = [
  fake('mcp__github__create_issue', 'Create a new issue in a repository'),
  fake('mcp__github__create_issue_comment', 'Add a comment to an issue'),
  fake('mcp__github__list_pulls', 'List pull requests'),
  fake('mcp__slack__post_message', 'Send a message to a channel'),
  fake('mcp__jira__search', 'Search the issue tracker for tickets, or create a filter'),
  fake('mcp__docs__find', 'Look up documentation pages'),
];

// ---------------------------------------------------------------------------
// planDeferral

test('planDeferral: nothing is deferred below or exactly at the threshold, everything above it', () => {
  const tools = [...BUILTINS, ...MCP];
  const cost = toolSpecTokens(MCP);
  assert.ok(cost > 0);
  assert.equal(DEFAULT_DEFER_THRESHOLD_PERCENT, 10);

  const below = planDeferral(tools, { contextWindow: cost * 20, state: freshState() });
  assert.deepEqual(names(below.active), names(tools));
  assert.deepEqual(below.deferred, []);

  // 10% of the window is exactly the cost of the MCP tools: still loaded.
  const at = planDeferral(tools, { contextWindow: cost * 10, state: freshState() });
  assert.deepEqual(names(at.active), names(tools));
  assert.deepEqual(at.deferred, []);

  const above = planDeferral(tools, { contextWindow: cost * 10 - 1, state: freshState() });
  assert.deepEqual(names(above.active), names(BUILTINS));
  assert.deepEqual(names(above.deferred), names(MCP));
});

test('planDeferral: a custom threshold moves the line, and 0 defers whenever there are MCP tools', () => {
  const tools = [...BUILTINS, ...MCP];
  const cost = toolSpecTokens(MCP);
  const window = cost * 4; // the MCP tools take 25% of the window

  assert.equal(planDeferral(tools, { contextWindow: window, state: freshState() }).deferred.length, MCP.length);
  assert.equal(planDeferral(tools, { contextWindow: window, thresholdPercent: 25, state: freshState() }).deferred.length, 0);
  assert.equal(planDeferral(tools, { contextWindow: window, thresholdPercent: 24, state: freshState() }).deferred.length, MCP.length);
  assert.equal(planDeferral(tools, { contextWindow: 1_000_000, thresholdPercent: 0, state: freshState() }).deferred.length, MCP.length);
  assert.equal(planDeferral(BUILTINS, { contextWindow: 1_000_000, thresholdPercent: 0, state: freshState() }).deferred.length, 0);
  // A nonsensical threshold falls back to the default.
  assert.equal(planDeferral(tools, { contextWindow: cost * 20, thresholdPercent: -5, state: freshState() }).deferred.length, 0);
});

test('planDeferral: loaded names and alwaysLoad stay active, in their original order', () => {
  const tools = [MCP[0]!, BUILTINS[0]!, MCP[1]!, MCP[2]!, BUILTINS[1]!, MCP[3]!, MCP[4]!, MCP[5]!];
  const plan = planDeferral(tools, {
    contextWindow: 100,
    state: freshState('mcp__slack__post_message', 'mcp__gone__tool'),
    alwaysLoad: (tool) => tool.name.startsWith('mcp__docs__'),
  });
  assert.deepEqual(names(plan.active), ['Read', 'Bash', 'mcp__slack__post_message', 'mcp__docs__find']);
  assert.deepEqual(names(plan.deferred), [
    'mcp__github__create_issue',
    'mcp__github__create_issue_comment',
    'mcp__github__list_pulls',
    'mcp__jira__search',
  ]);
  assert.equal(plan.active.length + plan.deferred.length, tools.length);
});

test('planDeferral: built-in tools are never deferred and never count toward the threshold', () => {
  const huge = fake('Bash', 'x'.repeat(50_000));
  const small = fake('mcp__tiny__ping', 'Ping');
  const window = 2000;
  assert.ok(toolSpecTokens([huge]) > window, 'the built-in alone is larger than the whole window');

  // The MCP tool is small, so nothing is deferred however large the built-ins are.
  const roomy = planDeferral([huge, small], { contextWindow: window, state: freshState() });
  assert.deepEqual(names(roomy.active), ['Bash', 'mcp__tiny__ping']);
  assert.deepEqual(roomy.deferred, []);

  // When MCP tools are deferred, built-ins stay, even ones alwaysLoad rejects.
  const tight = planDeferral([huge, fake('Read'), ...MCP], { contextWindow: 100, alwaysLoad: () => false, state: freshState() });
  assert.deepEqual(names(tight.active), ['Bash', 'Read']);
  assert.equal(tight.deferred.length, MCP.length);
  assert.ok(tight.deferred.every((t) => t.name.startsWith('mcp__')));
});

test('planDeferral: without a usable context window nothing is deferred, and the input is not modified', () => {
  const tools = [...BUILTINS, ...MCP];
  const before = names(tools);
  for (const contextWindow of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const plan = planDeferral(tools, { contextWindow, state: freshState() });
    assert.deepEqual(names(plan.active), before);
    assert.deepEqual(plan.deferred, []);
    assert.notEqual(plan.active, tools, 'a copy is returned');
  }
  assert.deepEqual(names(tools), before);
});

// ---------------------------------------------------------------------------
// ToolSearch

function search(deferred: Tool[], state: DeferralState = freshState()) {
  const tool = toolSearchTool(() => deferred, state);
  return {
    tool,
    state,
    run: async (input: { query: string; max_results?: number }) => tool.execute(input, ctx()),
  };
}

function resultNames(content: string): string[] {
  return content
    .split('\n')
    .filter((line) => line.startsWith('mcp__'))
    .map((line) => line.split(':')[0]!);
}

test('ToolSearch: is a read-only tool that needs no permission', () => {
  const { tool } = search(MCP);
  assert.equal(tool.name, 'ToolSearch');
  assert.equal(tool.isReadOnly({ query: 'x' }), true);
  assert.equal(tool.permission, undefined);
  assert.deepEqual(tool.parameters.required, ['query']);
  assert.deepEqual(Object.keys(tool.parameters.properties ?? {}), ['query', 'max_results']);
  assert.ok(tool.description.length < 300, 'the description stays short');
});

test('ToolSearch: ranks the exact name, then name substrings, then all words, then any word', async () => {
  const exactFirst = await search(MCP).run({ query: 'create_issue' });
  assert.equal(exactFirst.isError, undefined);
  assert.deepEqual(resultNames(exactFirst.content), [
    'mcp__github__create_issue', // the tool's own name
    'mcp__github__create_issue_comment', // contains the query
    'mcp__jira__search', // "create" and "issue" are both in its description
  ]);

  // The full name comes first; tools sharing only the word "github" follow, by name.
  const fullName = await search(MCP).run({ query: 'mcp__github__list_pulls' });
  assert.deepEqual(resultNames(fullName.content), ['mcp__github__list_pulls', 'mcp__github__create_issue', 'mcp__github__create_issue_comment']);
  const onlyOne = await search(MCP).run({ query: 'mcp__github__list_pulls', max_results: 1 });
  assert.deepEqual(resultNames(onlyOne.content), ['mcp__github__list_pulls']);

  // Spaces work like the underscores in tool names.
  const spaced = await search(MCP).run({ query: 'Create Issue' });
  assert.equal(resultNames(spaced.content)[0], 'mcp__github__create_issue');

  const allWords = await search(MCP).run({ query: 'message channel' });
  assert.deepEqual(resultNames(allWords.content), ['mcp__slack__post_message']);

  // "comment" appears in one tool; "documentation" in another: both are any-word matches, ordered by name.
  const anyWord = await search(MCP).run({ query: 'documentation comment' });
  assert.deepEqual(resultNames(anyWord.content), ['mcp__docs__find', 'mcp__github__create_issue_comment']);

  // A tool with every word outranks one with only some of them, whatever their names.
  const pairOfTools = [fake('mcp__a__alpha', 'Send an email'), fake('mcp__z__zulu', 'Send a calendar invite by email')];
  const everyWord = await search(pairOfTools).run({ query: 'calendar email' });
  assert.deepEqual(resultNames(everyWord.content), ['mcp__z__zulu', 'mcp__a__alpha']);

  const mixed = await search(MCP).run({ query: 'issue comment' });
  assert.deepEqual(resultNames(mixed.content), [
    'mcp__github__create_issue_comment', // name contains "issue_comment"
    'mcp__github__create_issue',
    'mcp__jira__search',
  ]);
});

test('ToolSearch: ties are broken by name, and filler words do not match everything', async () => {
  const shuffled = [fake('mcp__b__zeta', 'Report on widgets'), fake('mcp__a__alpha', 'Report on widgets'), fake('mcp__a__beta', 'Report on widgets')];
  const tied = await search(shuffled).run({ query: 'widgets' });
  assert.deepEqual(resultNames(tied.content), ['mcp__a__alpha', 'mcp__a__beta', 'mcp__b__zeta']);

  // "the", "for", "mcp" and "tool" are ignored when the query has real words.
  const filler = await search(MCP).run({ query: 'the mcp tool for documentation' });
  assert.deepEqual(resultNames(filler.content), ['mcp__docs__find']);
});

test('ToolSearch: max_results defaults to 5 and can be lowered or raised', async () => {
  const many = Array.from({ length: 30 }, (_, i) => fake(`mcp__srv__report_${String(i).padStart(2, '0')}`, 'Build a report'));

  const byDefault = await search(many).run({ query: 'report' });
  assert.deepEqual(resultNames(byDefault.content), ['mcp__srv__report_00', 'mcp__srv__report_01', 'mcp__srv__report_02', 'mcp__srv__report_03', 'mcp__srv__report_04']);
  assert.equal(byDefault.summary, 'Loaded 5 tools');

  const two = search(many);
  assert.equal(resultNames((await two.run({ query: 'report', max_results: 2 })).content).length, 2);
  assert.deepEqual([...two.state.loaded], ['mcp__srv__report_00', 'mcp__srv__report_01']);

  assert.equal(resultNames((await search(many).run({ query: 'report', max_results: 8 })).content).length, 8);
  assert.equal(resultNames((await search(many).run({ query: 'report', max_results: 500 })).content).length, 20, 'capped');
  // Values a model may send by mistake fall back to the default.
  assert.equal(resultNames((await search(many).run({ query: 'report', max_results: 0 })).content).length, 5);
  assert.equal(resultNames((await search(many).run({ query: 'report', max_results: 'three' as unknown as number })).content).length, 5);
  assert.equal(resultNames((await search(many).run({ query: 'report', max_results: '3' as unknown as number })).content).length, 3);
});

test('ToolSearch: select: loads exact names and reports the ones it cannot', async () => {
  const s = search(MCP, freshState('mcp__old__loaded'));
  const res = await s.run({ query: 'select:mcp__slack__post_message, mcp__docs__find,mcp__nope__missing,mcp__old__loaded' });
  assert.equal(res.isError, undefined);
  assert.deepEqual(resultNames(res.content), ['mcp__slack__post_message', 'mcp__docs__find']);
  assert.match(res.content, /These tools are now available to call\./);
  assert.match(res.content, /Already available: mcp__old__loaded\./);
  assert.match(res.content, /No tool named mcp__nope__missing\./);
  assert.deepEqual([...s.state.loaded].sort(), ['mcp__docs__find', 'mcp__old__loaded', 'mcp__slack__post_message']);

  // select: is not limited by max_results, is case-insensitive, and accepts the short name when it is unambiguous.
  const all = search(MCP);
  const everything = await all.run({ query: `SELECT: ${MCP.map((t) => t.name.toUpperCase()).join(',')}`, max_results: 1 });
  assert.equal(resultNames(everything.content).length, MCP.length);
  const short = await search(MCP).run({ query: 'select:post_message' });
  assert.deepEqual(resultNames(short.content), ['mcp__slack__post_message']);
  assert.match(short.content, /This tool is now available to call\./);

  // Two servers with the same tool name: the short form is ambiguous, so nothing is guessed.
  const twins = search([fake('mcp__a__run'), fake('mcp__b__run')]);
  const ambiguous = await twins.run({ query: 'select:run' });
  assert.equal(ambiguous.isError, undefined);
  assert.match(ambiguous.content, /No tool named run\./);
  assert.match(ambiguous.content, /mcp__a__run, mcp__b__run/);
  assert.equal(twins.state.loaded.size, 0);

  const empty = await search(MCP).run({ query: 'select:' });
  assert.equal(empty.isError, undefined);
  assert.match(empty.content, /No tool names followed "select:"/);
});

test('ToolSearch: no match is a normal result that lists up to 20 available names', async () => {
  const few = search(MCP);
  const res = await few.run({ query: 'kubernetes' });
  assert.equal(res.isError, undefined);
  assert.match(res.content, /No tools matched "kubernetes"\./);
  for (const tool of MCP) assert.ok(res.content.includes(tool.name));
  assert.doesNotMatch(res.content, /more\)/);
  assert.equal(few.state.loaded.size, 0);

  const many = Array.from({ length: 27 }, (_, i) => fake(`mcp__srv__t${String(i).padStart(2, '0')}`));
  const big = await search(many).run({ query: 'kubernetes' });
  assert.equal(big.isError, undefined);
  assert.equal((big.content.match(/mcp__srv__t\d\d/g) ?? []).length, 20);
  assert.match(big.content, /\(and 7 more\)/);

  const blank = await search(MCP).run({ query: '   ' });
  assert.equal(blank.isError, true, 'a missing query is a mistake, not an empty search');

  const none = await search([]).run({ query: 'anything' });
  assert.equal(none.isError, undefined);
  assert.match(none.content, /No tools are waiting to be loaded/);

  // A lookup that fails is an error result, not an exception in the agent loop.
  const broken = toolSearchTool(() => {
    throw new Error('registry unavailable');
  }, freshState());
  const failed = await broken.execute({ query: 'anything' }, ctx());
  assert.equal(failed.isError, true);
  assert.match(failed.content, /Could not look up the tools: registry unavailable/);
});

test('ToolSearch: each result is the name and a description cut to about 200 characters', async () => {
  const wordy = fake('mcp__docs__explain', `Explain   things\n\nat length. ${'very '.repeat(200)}long`);
  const res = await search([wordy, fake('mcp__docs__bare', '')]).run({ query: 'select:mcp__docs__explain,mcp__docs__bare' });
  const [first, second, closing] = res.content.split('\n');
  assert.ok(first!.startsWith('mcp__docs__explain: Explain things at length. very very'));
  assert.ok(first!.length <= 'mcp__docs__explain: '.length + 200);
  assert.ok(first!.endsWith(String.fromCodePoint(0x2026)));
  assert.equal(second, 'mcp__docs__bare');
  assert.equal(closing, 'These tools are now available to call.');
});

test('ToolSearch: tools it loads are active on the next planDeferral', async () => {
  const all = [...BUILTINS, ...MCP];
  const state = freshState();
  const plan = () => planDeferral(all, { contextWindow: 100, state });
  const tool = toolSearchTool(() => plan().deferred, state);

  assert.deepEqual(names(plan().active), names(BUILTINS));
  await tool.execute({ query: 'post a message to a channel', max_results: 1 }, ctx());
  assert.deepEqual(names(plan().active), [...names(BUILTINS), 'mcp__slack__post_message']);
  assert.equal(plan().deferred.length, MCP.length - 1);

  // A loaded tool is no longer a search result; the next best match is.
  const again = await tool.execute({ query: 'message' }, ctx());
  assert.ok(!resultNames(again.content).includes('mcp__slack__post_message'));

  await tool.execute({ query: `select:${MCP.map((t) => t.name).join(',')}` }, ctx());
  assert.deepEqual(names(plan().active), names(all));
  assert.deepEqual(plan().deferred, []);
  const done = await tool.execute({ query: 'issue' }, ctx());
  assert.match(done.content, /No tools are waiting to be loaded/);
});

// ---------------------------------------------------------------------------
// deferredListing

test('deferredListing: empty when nothing is deferred', () => {
  assert.equal(deferredListing([]), '');
});

test('deferredListing: groups tool names by server and tells the model to use ToolSearch', () => {
  const listing = deferredListing([...MCP, fake('mcp__my_server_v1__dotted_name')]);
  assert.deepEqual(listing.split('\n'), [
    '# More tools',
    '7 more tools are available but not loaded, listed by server. Full names are mcp__<server>__<tool>.',
    '- github: create_issue, create_issue_comment, list_pulls',
    '- slack: post_message',
    '- jira: search',
    '- docs: find',
    '- my_server_v1: dotted_name',
    'Before using any of them, call ToolSearch with keywords or "select:<full name>" to load it.',
  ]);
  assert.match(deferredListing([MCP[0]!]), /^# More tools\n1 more tool is available/);
  // A name that does not follow the MCP pattern is still listed, in full.
  assert.match(deferredListing([fake('Oddball'), fake('mcp__nosep')]), /\n- Oddball, mcp__nosep\n/);
});

test('deferredListing: stays near 1,500 characters and says how many names were left out', () => {
  const many = [
    ...Array.from({ length: 150 }, (_, i) => fake(`mcp__warehouse__inventory_report_${i}`)),
    ...Array.from({ length: 150 }, (_, i) => fake(`mcp__billing__invoice_${i}`)),
  ];
  const listing = deferredListing(many);
  assert.ok(listing.length <= 1500, `listing is ${listing.length} characters`);
  assert.ok(listing.length > 1300, 'the room is used');
  assert.match(listing, /^# More tools\n300 more tools are available/);
  assert.ok(listing.endsWith('call ToolSearch with keywords or "select:<full name>" to load it.'));

  const shown = (listing.match(/inventory_report_\d+|invoice_\d+/g) ?? []).length;
  assert.ok(shown > 20 && shown < 300);
  const omitted = /\((\d+) more not listed here; ToolSearch finds them by keyword\.\)/.exec(listing);
  assert.ok(omitted, listing.slice(-300));
  assert.equal(Number(omitted[1]), 300 - shown);

  // Everything fits: no note about omissions.
  assert.doesNotMatch(deferredListing(MCP), /not listed/);
});

// ---------------------------------------------------------------------------
// ENABLE_TOOL_SEARCH

test('toolSearchThreshold: reads ENABLE_TOOL_SEARCH values', () => {
  assert.equal(toolSearchThreshold(undefined), 10);
  assert.equal(toolSearchThreshold(''), 10);
  assert.equal(toolSearchThreshold('auto'), 10);
  assert.equal(toolSearchThreshold(' AUTO:25 '), 25);
  assert.equal(toolSearchThreshold('auto:0'), 0);
  assert.equal(toolSearchThreshold('auto:2.5'), 2.5);
  assert.equal(toolSearchThreshold('auto:400'), 100);
  assert.equal(toolSearchThreshold('true'), 0);
  assert.equal(toolSearchThreshold('1'), 0);
  assert.equal(toolSearchThreshold('false'), null);
  assert.equal(toolSearchThreshold('0'), null);
  assert.equal(toolSearchThreshold('auto:lots'), 10);
  assert.equal(toolSearchThreshold('banana'), 10);
});
