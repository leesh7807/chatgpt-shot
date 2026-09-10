import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownResult } from '../src/serialize.js';
test('serializes headings, lists, code, and nested blocks', async () => {
  const blocks = new Map<string, any[]>([['page', [{ id:'h', type:'heading_1', heading_1:{rich_text:[{plain_text:'Title'}]},has_children:false }, { id:'l', type:'bulleted_list_item', bulleted_list_item:{rich_text:[{plain_text:'one'}]},has_children:true }, { id:'c', type:'code', code:{language:'ts',rich_text:[{plain_text:'let x = 1;'}]},has_children:false }]], ['l', [{id:'n',type:'numbered_list_item',numbered_list_item:{rich_text:[{plain_text:'nested'}]},has_children:false}]]]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '# Title\n\n- one\n    1. nested\n\n```ts\nlet x = 1;\n```');
});
test('preserves rich-text hyperlink targets', async () => {
  const result = await markdownResult({ children: async () => [{ id:'p', type:'paragraph', paragraph:{rich_text:[{plain_text:'OpenAI',href:'https://openai.com'}]},has_children:false }] } as any, 'page');
  assert.equal(result, '[OpenAI](https://openai.com)');
});
test('serializes Notion tables with headers and cells', async () => {
  const blocks = new Map<string, any[]>([['page', [{ id:'t', type:'table', table:{has_column_header:true}, has_children:true }]], ['t', [{ id:'r1',type:'table_row',table_row:{cells:[[{plain_text:'Name'}],[{plain_text:'URL'}]]},has_children:false }, { id:'r2',type:'table_row',table_row:{cells:[[{plain_text:'OpenAI'}],[{plain_text:'https://openai.com'}]]},has_children:false }]]]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '| Name | URL |\n| --- | --- |\n| OpenAI | https://openai.com |');
});
test('uses a synthetic Markdown header for a headerless Notion table', async () => {
  const blocks = new Map<string, any[]>([
    ['page', [{ id: 't', type: 'table', table: { has_column_header: false }, has_children: true }]],
    ['t', [
      { id: 'r1', type: 'table_row', table_row: { cells: [[{ plain_text: 'Alice' }], [{ plain_text: '10' }]] }, has_children: false },
      { id: 'r2', type: 'table_row', table_row: { cells: [[{ plain_text: 'Bob' }], [{ plain_text: '20' }]] }, has_children: false },
    ]],
  ]);

  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '| Alice | 10 |\n| --- | --- |\n| Bob | 20 |');
});
test('keeps adjacent Notion tables as separate Markdown blocks', async () => {
  const blocks = new Map<string, any[]>([
    ['page', [
      { id:'first',type:'table',table:{has_column_header:false},has_children:true },
      { id:'second',type:'table',table:{has_column_header:false},has_children:true },
    ]],
    ['first', [{ id:'first-row',type:'table_row',table_row:{cells:[[{plain_text:'A'}]]},has_children:false }]],
    ['second', [{ id:'second-row',type:'table_row',table_row:{cells:[[{plain_text:'B'}]]},has_children:false }]],
  ]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '| A |\n| --- |\n\n| B |\n| --- |');
});
test('serializes media URLs instead of failing completed Results', async () => {
  const result = await markdownResult({ children: async () => [
    { id:'image',type:'image',image:{external:{url:'https://example.com/image.png'},caption:[{plain_text:'Diagram'}]},has_children:false },
    { id:'bookmark',type:'bookmark',bookmark:{url:'https://example.com'},has_children:false },
  ] } as any, 'page');
  assert.equal(result, '![Diagram](https://example.com/image.png)\n\nhttps://example.com');
});
test('preserves Notion to-do completion state', async () => {
  const result = await markdownResult({ children: async () => [
    { id:'unchecked',type:'to_do',to_do:{rich_text:[{plain_text:'deploy'}],checked:false},has_children:false },
    { id:'checked',type:'to_do',to_do:{rich_text:[{plain_text:'verify'}],checked:true},has_children:false },
  ] } as any, 'page');
  assert.equal(result, '- [ ] deploy\n- [x] verify');
});
test('keeps non-list children within their list item', async () => {
  const blocks = new Map<string, any[]>([
    ['page', [{ id:'item',type:'bulleted_list_item',bulleted_list_item:{rich_text:[{plain_text:'Deploy'}]},has_children:true }]],
    ['item', [{ id:'detail',type:'paragraph',paragraph:{rich_text:[{plain_text:'Only after tests pass'}]},has_children:false }]],
  ]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '- Deploy\n\n    Only after tests pass');
});
test('does not turn children of non-list blocks into indented code', async () => {
  const blocks = new Map<string, any[]>([
    ['page', [{ id:'toggle',type:'toggle',toggle:{rich_text:[{plain_text:'Details'}]},has_children:true }]],
    ['toggle', [{ id:'detail',type:'paragraph',paragraph:{rich_text:[{plain_text:'Nested text'}]},has_children:false }]],
  ]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, 'Details\n\nNested text');
});
test('uses a fence longer than backticks in Notion code', async () => {
  const result = await markdownResult({ children: async () => [{ id:'code',type:'code',code:{language:'markdown',rich_text:[{plain_text:'before\n```\nafter'}]},has_children:false }] } as any, 'page');
  assert.equal(result, '````markdown\nbefore\n```\nafter\n````');
});
test('preserves Notion equation expressions', async () => {
  const result = await markdownResult({ children: async () => [{ id:'equation',type:'equation',equation:{expression:'e=mc^2'},has_children:false }] } as any, 'page');
  assert.equal(result, '$$\ne=mc^2\n$$');
});
test('does not normalize list or table-looking literal code', async () => {
  const result = await markdownResult({ children: async () => [{ id:'code',type:'code',code:{language:'text',rich_text:[{plain_text:'- first\n\n- second\n\n| literal'}]},has_children:false }] } as any, 'page');
  assert.equal(result, '```text\n- first\n\n- second\n\n| literal\n```');
});
test('escapes literal Markdown syntax and preserves Notion annotations', async () => {
  const result = await markdownResult({ children: async () => [
    { id:'literal',type:'paragraph',paragraph:{rich_text:[{plain_text:'--- *literal*'}]},has_children:false },
    { id:'formatted',type:'paragraph',paragraph:{rich_text:[{plain_text:'bold',annotations:{bold:true}},{plain_text:' code',annotations:{code:true}}]},has_children:false },
  ] } as any, 'page');
  assert.equal(result, '--- \\*literal\\*\n\n**bold**`  code `');
});
test('keeps table pipes inside annotated inline code in their cell', async () => {
  const blocks = new Map<string, any[]>([
    ['page', [{ id:'t',type:'table',table:{has_column_header:true},has_children:true }]],
    ['t', [{ id:'r',type:'table_row',table_row:{cells:[[{plain_text:'a|b',annotations:{code:true}}],[{plain_text:'c'}]]},has_children:false }]],
  ]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '| ` a\\|b ` | c |\n| --- | --- |');
});
test('preserves inline-code boundary backticks, spaces, and literal tildes', async () => {
  const result = await markdownResult({ children: async () => [{ id:'p',type:'paragraph',paragraph:{rich_text:[
    {plain_text:'`x`',annotations:{code:true}}, {plain_text:' '}, {plain_text:' x ',annotations:{code:true}}, {plain_text:' ~~literal~~'},
  ]},has_children:false }] } as any, 'page');
  assert.equal(result, '`` `x` `` `  x  ` \\~\\~literal\\~\\~');
});
test('keeps numbered, HTML, and entity-looking text literal', async () => {
  const result = await markdownResult({ children: async () => [{ id:'p',type:'paragraph',paragraph:{rich_text:[{plain_text:'1. literal\n<b>raw</b> &copy;'}]},has_children:false }] } as any, 'page');
  assert.equal(result, '1\\. literal\n\\<b\\>raw\\</b\\> \\&copy;');
});
test('keeps setext-looking and indented paragraph text literal', async () => {
  const result = await markdownResult({ children: async () => [{ id:'p',type:'paragraph',paragraph:{rich_text:[{plain_text:'Title\n===\n\ntext\n\n    code'}]},has_children:false }] } as any, 'page');
  assert.equal(result, 'Title\n\\===\n\ntext\n\n&nbsp;&nbsp;&nbsp;&nbsp;code');
});
test('escapes short Setext and tab-terminated literal block markers', async () => {
  const result = await markdownResult({ children: async () => [{ id:'p',type:'paragraph',paragraph:{rich_text:[{plain_text:'Title\n=\n#\tHeading\n1)\titem'}]},has_children:false }] } as any, 'page');
  assert.equal(result, 'Title\n\\=\n\\#\tHeading\n1\\)\titem');
});
test('keeps multiline table cells inside one physical Markdown row', async () => {
  const blocks = new Map<string, any[]>([
    ['page', [{ id:'t',type:'table',table:{has_column_header:true},has_children:true }]],
    ['t', [{ id:'r',type:'table_row',table_row:{cells:[[{plain_text:'a\nb'}],[{plain_text:'c'}]]},has_children:false }]],
  ]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '| a<br>b | c |\n| --- | --- |');
});
test('keeps balanced parentheses URLs as links', async () => {
  const result = await markdownResult({ children: async () => [{ id:'p',type:'paragraph',paragraph:{rich_text:[{plain_text:'Open',href:'https://example.com/foo(bar)'}]},has_children:false }] } as any, 'page');
  assert.equal(result, '[Open](https://example.com/foo\\(bar\\))');
});
test('keeps quote descendants within the blockquote', async () => {
  const blocks = new Map<string, any[]>([
    ['page', [{ id:'q',type:'quote',quote:{rich_text:[{plain_text:'Parent'}]},has_children:true }]],
    ['q', [{ id:'p',type:'paragraph',paragraph:{rich_text:[{plain_text:'Child'}]},has_children:false }]],
  ]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '> Parent\n>\n> Child');
});
test('keeps quote descendants inside their list item in ancestor order', async () => {
  const blocks = new Map<string, any[]>([
    ['page', [{ id:'l',type:'bulleted_list_item',bulleted_list_item:{rich_text:[{plain_text:'item'}]},has_children:true }]],
    ['l', [{ id:'q',type:'quote',quote:{rich_text:[{plain_text:'Parent'}]},has_children:true }]],
    ['q', [{ id:'p',type:'paragraph',paragraph:{rich_text:[{plain_text:'Child'}]},has_children:false }]],
  ]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '- item\n\n    > Parent\n    >\n    > Child');
});
test('keeps multiple list children in one blockquote', async () => {
  const blocks = new Map<string, any[]>([
    ['page', [{ id:'q',type:'quote',quote:{rich_text:[{plain_text:'Parent'}]},has_children:true }]],
    ['q', [
      { id:'a',type:'bulleted_list_item',bulleted_list_item:{rich_text:[{plain_text:'A'}]},has_children:false },
      { id:'b',type:'bulleted_list_item',bulleted_list_item:{rich_text:[{plain_text:'B'}]},has_children:false },
    ]],
  ]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '> Parent\n>\n> - A\n>\n> - B');
});
test('keeps an inner quote intact through quote-list-quote ancestry', async () => {
  const blocks = new Map<string, any[]>([
    ['page', [{ id:'outer',type:'quote',quote:{rich_text:[{plain_text:'Outer'}]},has_children:true }]],
    ['outer', [{ id:'item',type:'bulleted_list_item',bulleted_list_item:{rich_text:[{plain_text:'item'}]},has_children:true }]],
    ['item', [{ id:'inner',type:'quote',quote:{rich_text:[{plain_text:'Inner'}]},has_children:true }]],
    ['inner', [
      { id:'a',type:'bulleted_list_item',bulleted_list_item:{rich_text:[{plain_text:'A'}]},has_children:false },
      { id:'b',type:'bulleted_list_item',bulleted_list_item:{rich_text:[{plain_text:'B'}]},has_children:false },
    ]],
  ]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '> Outer\n>\n> - item\n>\n>     > Inner\n>     >\n>     > - A\n>     >\n>     > - B');
});
test('preserves a literal backslash before an inline-code table pipe', async () => {
  const blocks = new Map<string, any[]>([
    ['page', [{ id:'t',type:'table',table:{has_column_header:true},has_children:true }]],
    ['t', [{ id:'r',type:'table_row',table_row:{cells:[[{plain_text:'a\\|b',annotations:{code:true}}],[{plain_text:'c'}]]},has_children:false }]],
  ]);
  const result = await markdownResult({ children: async (id: string) => blocks.get(id) ?? [] } as any, 'page');
  assert.equal(result, '| ` a\\\\\\|b ` | c |\n| --- | --- |');
});
