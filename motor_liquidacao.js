/*!
 * Motor de liquidação – Manual de Cálculos da Justiça Federal (ed. 2026, Res. CJF 990/2026)
 * Funções puras, sem dependências e sem acesso a dados do processo. Funciona no navegador
 * (window.MotorLiquidacao), no Node (require) e como módulo (import via bundler).
 *
 * Uso básico:
 *   const indices = await MotorLiquidacao.carregarIndices('https://iermack.github.io/liquidacao/indices.json');
 *   const r = MotorLiquidacao.calcular(
 *     { perfil: 'FAZ', dataBase: '2026-11-30' },
 *     [{ rotulo: '03/2021', valor: 401.72, competencia: '2021-03' }],
 *     indices);
 *   r.totais.total   // total atualizado
 *   r.linhas         // memória de cálculo por parcela
 */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.MotorLiquidacao = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSAO = '2026.11.12-4'; // muda a cada alteração de regra; guarde junto com o resultado

  /* ---------- perfis e regras (Manual 2026) ---------- */
  const PERFIS = {
    FAZ: { nome: 'Condenatórias – devedor Fazenda Pública (inclui servidores)', item: '4.2', serie: 'ipcae', taxaLegal: 'bcb',
           regras: { ipcaeFim: '2021-11', selicIni: '2021-12', selicFim: '2025-08', taxaLegalIni: '2025-09' }, juros2021: true, exigeCitacao: false, calibracao: 'calibrado' },
    NAO: { nome: 'Condenatórias – devedor não enquadrado como Fazenda Pública', item: '4.2', serie: 'ipcae', taxaLegal: 'bcb',
           regras: { selicFim: '2024-08', taxaLegalIni: '2024-09' }, juros2021: false, exigeCitacao: true, calibracao: 'parcial' },
    PREV: { nome: 'Benefício previdenciário', item: '4.3', serie: 'inpc', taxaLegal: 'prev',
           regras: { ipcaeFim: '2021-11', selicIni: '2021-12', selicFim: '2025-08', taxaLegalIni: '2025-09' }, juros2021: true, exigeCitacao: false, calibracao: 'sem exemplo no Manual' },
    DES: { nome: 'Desapropriações diretas (correção e SELIC; sem juros compensatórios)', item: '4.5', serie: 'ipcae', taxaLegal: 'bcb',
           regras: { ipcaeFim: '2021-11', selicIni: '2021-12', selicFim: '2025-08', taxaLegalIni: '2025-09' }, juros2021: true, exigeCitacao: false, calibracao: 'parcial' },
    REP: { nome: 'Repetição de indébito tributário', item: '4.4', serie: 'ipcae', taxaLegal: 'bcb',
           regras: { selicIni: '1996-01' }, juros2021: false, exigeCitacao: false, calibracao: 'calibrado' }
  };

  /* ---------- utilitários de competência (AAAA-MM) ---------- */
  const mAdd = (k, n) => { const [y, m] = k.split('-').map(Number); const t = y * 12 + m - 1 + n; return Math.floor(t / 12) + '-' + String(t % 12 + 1).padStart(2, '0'); };
  const mRange = (a, b) => { const r = []; for (let k = a; k <= b; k = mAdd(k, 1)) r.push(k); return r; };
  const mLbl = k => k.slice(5) + '/' + k.slice(0, 4);
  const mx = (a, b) => (a > b ? a : b);
  const mn = (a, b) => (a < b ? a : b);

  /* ---------- séries ---------- */
  const faltou = (nome, k) => new Error('Índice ' + nome + ' ainda não divulgado para ' + mLbl(k) + '. Use uma data-base anterior ou atualize os índices.');
  function fator(serie, de, ate, ix) { // produto de (1 + i) de 'de' a 'ate', inclusive
    if (de > ate) return 1; let f = 1; const s = ix[serie] || {};
    for (const k of mRange(de, ate)) { const v = s[k]; if (v === undefined) throw faltou(serie === 'inpc' ? 'INPC' : 'IPCA-E/IPCA-15', k); f *= 1 + v / 100; }
    return f;
  }
  function somaSelic(de, ate, ix) {
    if (de > ate) return 0; let s = 0;
    for (const k of mRange(de, ate)) { const v = ix.selic_fazenda[k]; if (v === undefined) throw faltou('SELIC', k); s += v; }
    return s / 100;
  }
  function somaTaxaLegal(tipo, de, ate, ix) {
    if (de > ate) return 0; let s = 0;
    for (const k of mRange(de, ate)) {
      const v = tipo === 'prev' ? ((ix.taxa_legal_prev || {})[k] || {}).taxa_legal : (ix.taxa_legal_bcb || {})[k];
      if (v === undefined || v === null) throw faltou(tipo === 'prev' ? 'da taxa legal previdenciária' : 'da taxa legal', k);
      s += v;
    }
    return s / 100;
  }
  function taxaPoupanca(k, perfil, ix) { // % ao mês (tabela de juros de poupança do PJe-Calc)
    if (perfil === 'PREV' && k < '2009-07') return 1.0;
    const tb = ix.juros_poupanca;
    if (!tb || !tb.length) throw new Error('Tabela de juros de poupança ausente dos índices: use o indices.json atualizado.');
    if (k < '2001-08') throw new Error('Termo inicial dos juros anterior a 08/2001 (1% ao mês para servidores): não implementado.');
    for (const r of tb) if (r.inicio <= k && (r.fim == null || k <= r.fim)) return r.taxa_pct;
    throw new Error('Juros de poupança ausentes para ' + mLbl(k) + '.');
  }
  function jurosPoupanca(inicio, perfil, ix) { // fração; soma simples de 'inicio' a 11/2021, truncada em 2 casas (como no exemplo do Manual)
    if (inicio > '2021-11') return 0; let s = 0;
    for (const k of mRange(inicio, '2021-11')) s += taxaPoupanca(k, perfil, ix);
    return Math.floor(s * 100 + 1e-9) / 10000;
  }

  /* ---------- cálculo ---------- */
  function normaliza(opcoes) {
    const cfg = PERFIS[opcoes.perfil];
    if (!cfg) throw new Error('Perfil desconhecido: ' + opcoes.perfil + '. Use FAZ, NAO, PREV, DES ou REP.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opcoes.dataBase || '')) throw new Error('dataBase deve estar no formato AAAA-MM-DD.');
    const P = Object.assign({ perfil: opcoes.perfil, cfg, serie: cfg.serie, tipoTaxaLegal: cfg.taxaLegal, dataBase: opcoes.dataBase,
      ultima: mAdd(opcoes.dataBase.slice(0, 7), -1), citacao: opcoes.citacao || '', jurosAte2021: opcoes.jurosAte2021 || 0 }, cfg.regras, opcoes.regras || {});
    if (cfg.exigeCitacao && !P.citacao) throw new Error('Informe o mês da citação (citacao: "AAAA-MM") para este perfil.');
    if (opcoes.perfil === 'NAO') { P.ipcaeFim = P.citacao; P.selicIni = mAdd(P.citacao, 1); }
    if (opcoes.perfil === 'REP') P.selicFim = P.ultima;
    return P;
  }
  function calcularParcela(P, p, ix) {
    const c = p.competencia, ultima = P.ultima; let coef, jAte = 0, sel = 0, tl = 0;
    if (P.perfil === 'REP') {
      if (c < '1996-01') throw new Error('Competência ' + mLbl(c) + ' anterior a 01/1996: use a tabela SICOM Repetição de Indébito (IPC, Ufir etc.).');
      coef = 1; sel = somaSelic(mAdd(c, 1), P.ultima, ix) + (c < P.dataBase.slice(0, 7) ? 0.01 : 0);
    } else if (P.perfil === 'NAO') {
      const fe = c <= P.citacao ? fator('ipcae', c, P.citacao, ix) : 1;
      coef = fe * fator('ipcae', mx(c, P.selicFim), ultima, ix);
      const si = mAdd(mx(c, P.citacao), 1);
      if (si < '2003-01') throw new Error('Juros anteriores a 01/2003 (0,5% simples) ainda não implementados neste perfil.');
      sel = somaSelic(si, mn(P.selicFim, ultima), ix); tl = somaTaxaLegal('bcb', mx(c, P.taxaLegalIni), ultima, ix);
    } else {
      if (P.perfil === 'PREV' && c < '2006-09') throw new Error('Competência ' + mLbl(c) + ' anterior a 09/2006: use a tabela SICOM Previdenciário (IGP-DI e IRSM).');
      const fe = c <= P.ipcaeFim ? fator(P.serie, c, P.ipcaeFim, ix) : 1;
      const ini = mx(c, P.taxaLegalIni); coef = fe * fator(P.serie, ini, ultima, ix);
      const sFim = mn(P.selicFim, ultima); sel = c <= sFim ? somaSelic(mx(c, P.selicIni), sFim, ix) : 0;
      tl = somaTaxaLegal(P.tipoTaxaLegal, ini, ultima, ix);
    }
    const principal = p.valor * coef;
    if (P.cfg.juros2021 && c <= P.selicIni) {
      const taxa = P.citacao ? jurosPoupanca(mx(P.citacao, c), P.perfil, ix) : P.jurosAte2021;
      jAte = principal * taxa;
    }
    const jurosSelic = (principal + jAte) * sel, jurosTaxaLegal = principal * tl;
    return { rotulo: p.rotulo || mLbl(c), valor: p.valor, competencia: c, coeficiente: coef, principal, jurosAte2021: jAte,
             selicAcumulada: sel, jurosSelic, taxaLegalAcumulada: tl, jurosTaxaLegal, total: principal + jAte + jurosSelic + jurosTaxaLegal };
  }
  /**
   * @param {{perfil:'FAZ'|'NAO'|'PREV'|'DES'|'REP', dataBase:'AAAA-MM-DD', citacao?:'AAAA-MM', jurosAte2021?:number, regras?:object}} opcoes
   *   citacao = termo inicial dos juros de mora; em NAO é obrigatório; em FAZ/PREV/DES calcula os juros até 12/2021 pela tabela de poupança.
   *   jurosAte2021 = fração (ex.: 0.0245) usada só quando 'citacao' não é informada.
   * @param {{rotulo?:string, valor:number, competencia:'AAAA-MM'}[]} parcelas
   * @param {object} indices  conteúdo do indices.json
   */
  function calcular(opcoes, parcelas, indices) {
    const P = normaliza(opcoes); const linhas = parcelas.map(p => {
      if (!/^\d{4}-\d{2}$/.test(p.competencia || '') || !(typeof p.valor === 'number')) throw new Error('Parcela inválida (competencia "AAAA-MM" e valor numérico): ' + JSON.stringify(p));
      return calcularParcela(P, p, indices); });
    const soma = k => linhas.reduce((a, l) => a + l[k], 0);
    const totais = { valor: soma('valor'), principal: soma('principal'), jurosAte2021: soma('jurosAte2021'), jurosSelic: soma('jurosSelic'), jurosTaxaLegal: soma('jurosTaxaLegal'), total: soma('total') };
    const avisos = [];
    const futuras = linhas.filter(l => l.competencia > P.ultima).map(l => l.rotulo);
    if (futuras.length) avisos.push('Parcela(s) com competência posterior ao mês anterior à data-base (' + futuras.join(', ') + '): sem correção nem juros.');
    if (P.cfg.calibracao !== 'calibrado') avisos.push('Perfil ' + P.perfil + ': ' + P.cfg.calibracao + '. Confira com o Manual e com a tabela SICOM antes de usar em peça.');
    if (P.perfil === 'DES') avisos.push('Desapropriações: juros compensatórios e juros moratórios anteriores a dez/2021 não são calculados (informe jurosAte2021).');
    return { versaoMotor: VERSAO, indicesAtualizadosEm: (indices.atualizado_em || null), perfil: { codigo: opcoes.perfil, nome: P.cfg.nome, item: P.cfg.item }, parametros: P, linhas, totais, avisos };
  }
  const MESES_NOME={jan:1,fev:2,mar:3,abr:4,mai:5,jun:6,jul:7,ago:8,set:9,out:10,nov:11,dez:12};
  function lerCompetencia(txt){ // devolve {comp:'AAAA-MM', nota?} ou null
  let s=String(txt||'').trim(); if(!s) return null;
  const sem=s.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase(); let m;
  if((m=/^13\s*[.ºo°]*\s*[\/\-\s]?\s*(?:sal\w*\s*)?[\/\-\s]?\s*(\d{4})\b/.exec(sem))) return {comp:m[1]+'-12',nota:'13.º/'+m[1]+' tratado como competência 12/'+m[1]};
  if((m=/(\d{1,2})\s*\/\s*(\d{4})\b/.exec(sem))&&+m[1]>=1&&+m[1]<=12) return {comp:m[2]+'-'+m[1].padStart(2,'0')};
  if((m=/\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*[\s\/\-\.]*(\d{2}|\d{4})\b/.exec(sem))){ const y=m[2].length===2?2000+(+m[2]):+m[2]; return {comp:y+'-'+String(MESES_NOME[m[1]]).padStart(2,'0')}; }
  if((m=/^(\d{1,2})\s*[\/\-\.]\s*(\d{2})$/.exec(sem))&&+m[1]>=1&&+m[1]<=12) return {comp:(2000+(+m[2]))+'-'+m[1].padStart(2,'0')};
  return null;
}

  function lerParcelas(texto) { // texto colado do Excel -> {parcelas, erros, notas}
    const parcelas = [], erros = [], notas = [];
    String(texto || '').split(/\r?\n/).forEach((ln, i) => {
      if (!ln.trim()) return; const c = ln.split(/\t|;/).map(x => x.trim()).filter(x => x !== ''); // ignora colunas vazias coladas do Excel
      let v = c[1] === undefined ? NaN : String(c[1]).replace(/R\$\s*/, '').trim(); if (typeof v === 'string') v = v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v; v = Number(v);
      let r = lerCompetencia(c[0]); if (c[2]) { const r2 = lerCompetencia(c[2]); if (r2) r = r2; }
      if (isNaN(v) || !r) { erros.push('Linha ' + (i + 1) + ': informe valor e competência (MM/AAAA, mmm/aa ou 13.º/AAAA). Não inclua a linha de títulos.'); return; }
      if (r.nota && !notas.includes(r.nota)) notas.push(r.nota);
      parcelas.push({ rotulo: c[0], valor: v, competencia: r.comp });
    });
    return { parcelas, erros, notas };
  }
  function dataBasePadrao(hoje) { // último dia do mês de 'hoje' (Date), no formato AAAA-MM-DD
    const h = hoje || new Date(), u = new Date(h.getFullYear(), h.getMonth() + 1, 0), p = n => String(n).padStart(2, '0');
    return u.getFullYear() + '-' + p(u.getMonth() + 1) + '-' + p(u.getDate());
  }
  const arredonda = (v, n = 2) => Math.round(v * Math.pow(10, n) + (v >= 0 ? 1e-9 : -1e-9)) / Math.pow(10, n);

  async function carregarIndices(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error('Não foi possível carregar os índices (' + r.status + ').');
    const j = await r.json();
    if (!j.ipcae || !j.selic_fazenda || !j.taxa_legal_bcb) throw new Error('Arquivo de índices incompleto.');
    return j;
  }

  return { VERSAO, PERFIS, calcular, lerParcelas, lerCompetencia, dataBasePadrao, carregarIndices, arredonda, util: { mAdd, mRange, mLbl, fator, somaSelic, somaTaxaLegal, jurosPoupanca, taxaPoupanca } };
});
