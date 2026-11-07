// #1845 — which setting a press of I finds under the mouse. The browser's own hover and real panels
// are in p1845-i-keys-row.spec.ts; this pins the shapes the panels do not happen to contain today.
import { afterEach, describe, expect, it } from 'vitest';
import { KEY_ROW_ATTR, ROW_KEY_ATTR, registerRowKeyer, underMouse } from './rowKey';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Builds the HTML and marks every `[data-row-key]`, each keyer answering with its element's id. */
function build(html: string) {
  document.body.innerHTML = html;
  for (const el of document.querySelectorAll(`[${ROW_KEY_ATTR}]`)) {
    registerRowKeyer(el, { current: () => ({ ok: false, reason: el.id }) });
  }
}
const hoverChain = (id: string) => {
  const chain: Element[] = [];
  for (let at: Element | null = document.getElementById(id); at; at = at.parentElement) {
    chain.unshift(at);
  }
  return chain;
};
const keyedBy = (id: string) => {
  const found = underMouse(hoverChain(id));
  if (found.kind !== 'row') return found.kind;
  const result = found.key();
  return result.ok ? 'ok' : result.reason;
};

const MARK = (id: string) => `<button id="${id}" ${ROW_KEY_ATTR}></button>`;

describe('the row under the mouse', () => {
  it('the mark itself, a label around it, and a named row all key it', () => {
    build(`<label id="l"><span id="s"><b id="deep"></b>${MARK('a')}</span><input id="i"/></label>`);
    expect(keyedBy('a')).toBe('a');
    expect(keyedBy('deep')).toBe('a');
    expect(keyedBy('i')).toBe('a');
    build(`<div ${KEY_ROW_ATTR}><span>${MARK('a')}</span><label><input id="axis"/></label></div>`);
    expect(keyedBy('axis')).toBe('a');
  });

  it("the mark's direct parent is its row, and that parent's own parent is not", () => {
    build(
      `<section id="wide"><i id="off"></i><span id="own"><b id="t"></b>${MARK('a')}</span></section>`,
    );
    expect(keyedBy('t')).toBe('a');
    expect(keyedBy('off')).toBe('none');
    expect(keyedBy('wide')).toBe('none');
  });

  it('two marks in one row key neither', () => {
    build(`<label><input id="i"/>${MARK('a')}${MARK('b')}</label>`);
    expect(keyedBy('i')).toBe('field');
    build(`<div ${KEY_ROW_ATTR}><i id="t"></i>${MARK('a')}<span>${MARK('b')}</span></div>`);
    expect(keyedBy('t')).toBe('none');
    build(`<div id="p">${MARK('a')}${MARK('b')}<i id="sibling"></i></div>`);
    expect(keyedBy('sibling')).toBe('none');
  });

  it('a field on no keyable row says so; anything else is not a row', () => {
    build(`<label><input id="i"/></label><select id="s"></select><div id="d"></div>`);
    expect(keyedBy('i')).toBe('field');
    expect(keyedBy('s')).toBe('field');
    expect(keyedBy('d')).toBe('none');
    expect(underMouse([]).kind).toBe('none');
  });
});
