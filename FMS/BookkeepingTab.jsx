/**
 * ============================================================================
 * 복식부기 (Bookkeeping) Tab — for easyplay.it.kr/FMS
 * ============================================================================
 *
 * 통합 방법 (Integration steps):
 *   1. 이 파일을 기존 FMS 프로젝트의 컴포넌트 폴더에 넣으세요.
 *      (예: src/components/BookkeepingTab.jsx)
 *   2. 아래 "⚠ ADJUST" 표시된 부분을 실제 프로젝트에 맞게 수정하세요:
 *      - firebase import 경로
 *      - 기존 법인경비/급여관리 컬렉션명과 필드명
 *      - 스타일(className) — 기존 탭과 톤을 맞추려면 CSS를 조정하세요
 *   3. 최상위 탭 목록(고문경비/법인경비/급여관리)에 "복식부기" 탭을 추가하고
 *      이 컴포넌트를 렌더링하세요.
 *
 * 이 컴포넌트가 하는 일:
 *   - [자동반영] 기존 법인경비·급여관리 문서를 읽어와 분개로 자동 변환 제안
 *     (계정 매핑은 ACCOUNT_MAPPING 참고, 사용자가 "확정"을 눌러야 저장됨)
 *   - [수동입력] 법인경비에 안 잡히는 거래(매출/자본금/차입 등)를 직접 분개
 *   - [시산표/손익계산서/재무상태표] bookkeeping_entries 전체를 읽어 자동 집계
 *
 * 데이터는 새 Firestore 컬렉션 `bookkeeping_entries` 에 저장됩니다.
 * 기존 컬렉션(corpExpenses, payrollRecords)은 읽기만 하고 수정하지 않습니다.
 * ============================================================================
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";

// ⚠ ADJUST: 실제 프로젝트의 firebase 초기화 파일 경로로 바꾸세요.
import { db } from "../firebase";

// ----------------------------------------------------------------------------
// 1. 계정과목 (고정 목록 — 자주 바뀌지 않으므로 DB 대신 상수로 관리합니다)
// ----------------------------------------------------------------------------
export const ACCOUNTS = [
  { code: 101, name: "현금", type: "자산" },
  { code: 102, name: "보통예금", type: "자산" },
  { code: 103, name: "외상매출금", type: "자산" },
  { code: 104, name: "미수금", type: "자산" },
  { code: 105, name: "선급금", type: "자산" },
  { code: 106, name: "비품", type: "자산" },
  { code: 107, name: "소프트웨어", type: "자산" },
  { code: 201, name: "외상매입금", type: "부채" },
  { code: 202, name: "미지급금", type: "부채" },
  { code: 203, name: "예수금", type: "부채" },
  { code: 204, name: "선수금", type: "부채" },
  { code: 205, name: "미지급세금", type: "부채" },
  { code: 301, name: "자본금", type: "자본" },
  { code: 302, name: "이익잉여금", type: "자본" },
  { code: 401, name: "매출액", type: "수익" },
  { code: 402, name: "잡이익", type: "수익" },
  { code: 501, name: "급여", type: "비용" },
  { code: 502, name: "복리후생비", type: "비용" },
  { code: 503, name: "여비교통비", type: "비용" },
  { code: 504, name: "통신비", type: "비용" },
  { code: 505, name: "수도광열비", type: "비용" },
  { code: 506, name: "세금과공과", type: "비용" },
  { code: 507, name: "감가상각비", type: "비용" },
  { code: 508, name: "지급수수료", type: "비용" },
  { code: 509, name: "광고선전비", type: "비용" },
  { code: 510, name: "소모품비", type: "비용" },
  { code: 511, name: "임차료", type: "비용" },
  { code: 512, name: "접대비", type: "비용" },
  { code: 513, name: "외주용역비", type: "비용" },
  { code: 514, name: "지급이자", type: "비용" },
  { code: 515, name: "잡비", type: "비용" },
];

// ----------------------------------------------------------------------------
// 2. 계정 매핑 — 법인경비/급여관리 카테고리 → 복식부기 계정
//    ⚠ ADJUST: 기존 카테고리 문자열이 여기와 정확히 같은 철자인지 확인하세요.
// ----------------------------------------------------------------------------
const EXPENSE_CATEGORY_TO_ACCOUNT = {
  "지급수수료": "지급수수료",
  "통신비": "통신비",
  "임차료": "임차료",
  "소모품비": "소모품비",
  "여비교통비": "여비교통비",
  "접대비": "접대비",
  "광고선전비": "광고선전비",
  "인건비": "급여", // 급여관리 탭과 중복 방지: 법인경비의 "인건비"는 4대보험 등 별도 지출일 때만 사용 권장
  "기타": "잡비",
};

const PAYMENT_ACCOUNT_TO_CREDIT = {
  "법인통장": "보통예금",
  "법인카드": "미지급금",
  "대표이사 개인지출(정산대상)": "미지급금", // 임원 가지급 성격 — 필요시 별도 계정으로 세분화하세요
};

// ----------------------------------------------------------------------------
// 3. 기존 법인경비 문서 → 분개 변환
//    ⚠ ADJUST: 실제 corpExpenses 문서의 필드명에 맞춰 아래 프로퍼티명을 수정하세요.
//    (예: doc.amount, doc.category, doc.paymentAccount 등 실제 필드명 확인 필요)
// ----------------------------------------------------------------------------
function mapCorpExpenseToJournal(expenseDoc) {
  const debitAccount = EXPENSE_CATEGORY_TO_ACCOUNT[expenseDoc.category] || "잡비";
  const creditAccount = PAYMENT_ACCOUNT_TO_CREDIT[expenseDoc.paymentAccount] || "보통예금";
  return {
    date: expenseDoc.date,
    description: expenseDoc.description || expenseDoc.note || "법인경비",
    debitAccount,
    debitAmount: Number(expenseDoc.amount) || 0,
    creditAccount,
    creditAmount: Number(expenseDoc.amount) || 0,
    partner: expenseDoc.vendor || "",
    docType: expenseDoc.evidenceType || "",
    note: `[자동반영-법인경비] ${expenseDoc.note || ""}`.trim(),
    source: "auto-corp-expense",
    sourceCollection: "corpExpenses", // ⚠ ADJUST: 실제 컬렉션명
    sourceId: expenseDoc.id,
  };
}

// ----------------------------------------------------------------------------
// 4. 기존 급여 문서 → 분개 변환 (급여/예수금/보통예금 3계정 분개이므로 2행으로 분리)
//    ⚠ ADJUST: 실제 payrollRecords 문서의 필드명에 맞춰 수정하세요.
// ----------------------------------------------------------------------------
function mapPayrollToJournal(payrollDoc) {
  const taxableWage = Number(payrollDoc.taxableSalary) || 0;
  const nonTaxable = Number(payrollDoc.nonTaxable) || 0;
  const incomeTax = Number(payrollDoc.incomeTax) || 0;
  const localTax = Number(payrollDoc.localTax) || 0;
  const netPay = Number(payrollDoc.netPay) || 0;
  const totalGross = taxableWage + nonTaxable;
  const totalWithholding = incomeTax + localTax;

  const commonNote = `[자동반영-급여] ${payrollDoc.payMonth || ""}`;
  const entries = [];

  // 1행: 급여(차변 총액) / 예수금(대변 원천징수액)
  if (totalWithholding > 0) {
    entries.push({
      date: payrollDoc.payDate,
      description: "급여 지급 - 원천징수",
      debitAccount: "급여",
      debitAmount: totalWithholding,
      creditAccount: "예수금",
      creditAmount: totalWithholding,
      note: commonNote,
      source: "auto-payroll",
      sourceCollection: "payrollRecords", // ⚠ ADJUST: 실제 컬렉션명
      sourceId: payrollDoc.id,
    });
  }
  // 2행: 급여(차변 순지급분) / 보통예금(대변)
  entries.push({
    date: payrollDoc.payDate,
    description: "급여 지급 - 순지급액",
    debitAccount: "급여",
    debitAmount: totalGross - totalWithholding,
    creditAccount: "보통예금",
    creditAmount: netPay,
    note: commonNote,
    source: "auto-payroll",
    sourceCollection: "payrollRecords",
    sourceId: payrollDoc.id,
  });
  return entries;
}

// ----------------------------------------------------------------------------
// 5. Firestore 헬퍼
// ----------------------------------------------------------------------------
const ENTRIES_COLLECTION = "bookkeeping_entries";

async function fetchEntries() {
  const q = query(collection(db, ENTRIES_COLLECTION), orderBy("date", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchCollectionRaw(name) {
  // ⚠ ADJUST: 컬렉션명이 다르면 이 함수 호출부의 인자를 바꾸세요.
  try {
    const snap = await getDocs(collection(db, name));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn(`컬렉션 "${name}" 조회 실패 — 이름/권한을 확인하세요.`, e);
    return [];
  }
}

async function saveEntry(entry) {
  await addDoc(collection(db, ENTRIES_COLLECTION), {
    ...entry,
    createdAt: serverTimestamp(),
  });
}

// ----------------------------------------------------------------------------
// 6. 집계 로직 (시산표 / 손익계산서 / 재무상태표) — 클라이언트에서 계산
// ----------------------------------------------------------------------------
function computeTrialBalance(entries) {
  const map = new Map(ACCOUNTS.map((a) => [a.name, { ...a, debitSum: 0, creditSum: 0 }]));
  entries.forEach((e) => {
    if (map.has(e.debitAccount)) map.get(e.debitAccount).debitSum += Number(e.debitAmount) || 0;
    if (map.has(e.creditAccount)) map.get(e.creditAccount).creditSum += Number(e.creditAmount) || 0;
  });
  return Array.from(map.values()).map((a) => {
    const debitBal = a.debitSum >= a.creditSum ? a.debitSum - a.creditSum : 0;
    const creditBal = a.creditSum > a.debitSum ? a.creditSum - a.debitSum : 0;
    return { ...a, debitBal, creditBal };
  });
}

function computeIncomeStatement(trialBalance) {
  const revenue = trialBalance.filter((a) => a.type === "수익").reduce((s, a) => s + a.creditBal, 0);
  const expense = trialBalance.filter((a) => a.type === "비용").reduce((s, a) => s + a.debitBal, 0);
  return { revenue, expense, netIncome: revenue - expense };
}

function computeBalanceSheet(trialBalance, netIncome) {
  const assets = trialBalance.filter((a) => a.type === "자산").reduce((s, a) => s + a.debitBal, 0);
  const liabilities = trialBalance.filter((a) => a.type === "부채").reduce((s, a) => s + a.creditBal, 0);
  const capital = trialBalance.filter((a) => a.type === "자본").reduce((s, a) => s + a.creditBal, 0);
  const totalCapital = capital + netIncome;
  return { assets, liabilities, capital: totalCapital, balanced: assets === liabilities + totalCapital };
}

// ----------------------------------------------------------------------------
// 7. CSV 내보내기 (별도 라이브러리 없이 동작 — 기존 엑셀 내보내기와 별개로 간단 구현)
// ----------------------------------------------------------------------------
function exportEntriesToCSV(entries) {
  const headers = ["날짜", "적요", "차변계정", "차변금액", "대변계정", "대변금액", "거래처", "증빙", "비고"];
  const rows = entries.map((e) => [
    e.date, e.description, e.debitAccount, e.debitAmount, e.creditAccount, e.creditAmount, e.partner || "", e.docType || "", e.note || "",
  ]);
  const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `분개장_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------------------
// 8. 메인 컴포넌트
// ----------------------------------------------------------------------------
export default function BookkeepingTab() {
  const [subTab, setSubTab] = useState("auto"); // auto | manual | trial | pl | bs
  const [entries, setEntries] = useState([]);
  const [pendingAuto, setPendingAuto] = useState([]);
  const [loading, setLoading] = useState(false);

  // 수동입력 폼 상태
  const [form, setForm] = useState({
    date: "", description: "", debitAccount: "", debitAmount: "",
    creditAccount: "", creditAmount: "", partner: "", docType: "", note: "",
  });

  const loadEntries = async () => {
    setLoading(true);
    const data = await fetchEntries();
    setEntries(data);
    setLoading(false);
  };

  useEffect(() => { loadEntries(); }, []);

  // ---- 자동반영: 기존 법인경비/급여 데이터를 읽어 분개 후보 생성 ----
  const loadAutoCandidates = async () => {
    setLoading(true);
    const alreadyLinkedIds = new Set(entries.filter((e) => e.sourceId).map((e) => e.sourceId));

    const corpExpenses = await fetchCollectionRaw("corpExpenses"); // ⚠ ADJUST 컬렉션명
    const payrolls = await fetchCollectionRaw("payrollRecords"); // ⚠ ADJUST 컬렉션명

    const candidates = [];
    corpExpenses.forEach((doc) => {
      if (!alreadyLinkedIds.has(doc.id)) candidates.push(mapCorpExpenseToJournal(doc));
    });
    payrolls.forEach((doc) => {
      if (!alreadyLinkedIds.has(doc.id)) candidates.push(...mapPayrollToJournal(doc));
    });
    setPendingAuto(candidates);
    setLoading(false);
  };

  const confirmAutoEntry = async (entry) => {
    await saveEntry(entry);
    setPendingAuto((prev) => prev.filter((e) => e !== entry));
    await loadEntries();
  };

  const confirmAllAuto = async () => {
    for (const entry of pendingAuto) {
      await saveEntry(entry);
    }
    setPendingAuto([]);
    await loadEntries();
  };

  // ---- 수동입력 ----
  const handleManualSubmit = async (ev) => {
    ev.preventDefault();
    if (Number(form.debitAmount) !== Number(form.creditAmount)) {
      alert("차변금액과 대변금액이 일치해야 합니다.");
      return;
    }
    await saveEntry({ ...form, debitAmount: Number(form.debitAmount), creditAmount: Number(form.creditAmount), source: "manual" });
    setForm({ date: "", description: "", debitAccount: "", debitAmount: "", creditAccount: "", creditAmount: "", partner: "", docType: "", note: "" });
    await loadEntries();
  };

  // ---- 집계 (entries가 바뀔 때만 재계산) ----
  const trialBalance = useMemo(() => computeTrialBalance(entries), [entries]);
  const incomeStatement = useMemo(() => computeIncomeStatement(trialBalance), [trialBalance]);
  const balanceSheet = useMemo(() => computeBalanceSheet(trialBalance, incomeStatement.netIncome), [trialBalance, incomeStatement]);

  const fmt = (n) => Number(n || 0).toLocaleString("ko-KR");

  return (
    <div className="bookkeeping-tab">{/* ⚠ ADJUST: 기존 탭 스타일에 맞춰 className/CSS 조정 */}
      <div className="bookkeeping-subtabs">
        <button onClick={() => setSubTab("auto")}>자동반영 분개</button>
        <button onClick={() => setSubTab("manual")}>수동 분개 입력</button>
        <button onClick={() => setSubTab("trial")}>시산표</button>
        <button onClick={() => setSubTab("pl")}>손익계산서</button>
        <button onClick={() => setSubTab("bs")}>재무상태표</button>
        <button onClick={() => exportEntriesToCSV(entries)}>전체 분개 CSV 내보내기</button>
      </div>

      {loading && <p>불러오는 중...</p>}

      {subTab === "auto" && (
        <div>
          <p>법인경비·급여관리에 입력된 내역 중 아직 분개로 확정되지 않은 건을 불러옵니다.</p>
          <button onClick={loadAutoCandidates}>기존 내역 불러오기</button>
          {pendingAuto.length > 0 && (
            <>
              <button onClick={confirmAllAuto}>전체 확정</button>
              <table>
                <thead>
                  <tr>
                    <th>날짜</th><th>적요</th><th>차변</th><th>금액</th><th>대변</th><th>비고</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {pendingAuto.map((e, i) => (
                    <tr key={i}>
                      <td>{e.date}</td>
                      <td>{e.description}</td>
                      <td>{e.debitAccount}</td>
                      <td>{fmt(e.debitAmount)}</td>
                      <td>{e.creditAccount}</td>
                      <td>{e.note}</td>
                      <td><button onClick={() => confirmAutoEntry(e)}>확정</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {subTab === "manual" && (
        <div>
          <form onSubmit={handleManualSubmit}>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
            <input placeholder="적요" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required />
            <select value={form.debitAccount} onChange={(e) => setForm({ ...form, debitAccount: e.target.value })} required>
              <option value="">차변계정 선택</option>
              {ACCOUNTS.map((a) => <option key={a.code} value={a.name}>{a.name}</option>)}
            </select>
            <input type="number" placeholder="차변금액" value={form.debitAmount} onChange={(e) => setForm({ ...form, debitAmount: e.target.value })} required />
            <select value={form.creditAccount} onChange={(e) => setForm({ ...form, creditAccount: e.target.value })} required>
              <option value="">대변계정 선택</option>
              {ACCOUNTS.map((a) => <option key={a.code} value={a.name}>{a.name}</option>)}
            </select>
            <input type="number" placeholder="대변금액" value={form.creditAmount} onChange={(e) => setForm({ ...form, creditAmount: e.target.value })} required />
            <input placeholder="거래처" value={form.partner} onChange={(e) => setForm({ ...form, partner: e.target.value })} />
            <input placeholder="증빙" value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })} />
            <input placeholder="비고" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <button type="submit">분개 저장</button>
          </form>

          <table>
            <thead><tr><th>날짜</th><th>적요</th><th>차변</th><th>금액</th><th>대변</th><th>출처</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.date}</td><td>{e.description}</td><td>{e.debitAccount}</td>
                  <td>{fmt(e.debitAmount)}</td><td>{e.creditAccount}</td>
                  <td>{e.source === "manual" ? "수동" : e.source === "auto-corp-expense" ? "법인경비" : e.source === "auto-payroll" ? "급여" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subTab === "trial" && (
        <table>
          <thead><tr><th>계정</th><th>구분</th><th>차변합계</th><th>대변합계</th><th>차변잔액</th><th>대변잔액</th></tr></thead>
          <tbody>
            {trialBalance.filter((a) => a.debitSum || a.creditSum).map((a) => (
              <tr key={a.code}>
                <td>{a.name}</td><td>{a.type}</td>
                <td>{fmt(a.debitSum)}</td><td>{fmt(a.creditSum)}</td>
                <td>{fmt(a.debitBal)}</td><td>{fmt(a.creditBal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {subTab === "pl" && (
        <table>
          <tbody>
            <tr><td>수익 합계</td><td>{fmt(incomeStatement.revenue)}</td></tr>
            <tr><td>비용 합계</td><td>{fmt(incomeStatement.expense)}</td></tr>
            <tr><td><b>당기순이익</b></td><td><b>{fmt(incomeStatement.netIncome)}</b></td></tr>
          </tbody>
        </table>
      )}

      {subTab === "bs" && (
        <table>
          <tbody>
            <tr><td>자산 합계</td><td>{fmt(balanceSheet.assets)}</td></tr>
            <tr><td>부채 합계</td><td>{fmt(balanceSheet.liabilities)}</td></tr>
            <tr><td>자본 합계(당기순이익 반영)</td><td>{fmt(balanceSheet.capital)}</td></tr>
            <tr><td>검증</td><td>{balanceSheet.balanced ? "일치" : "불일치 — 분개 확인 필요"}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * ============================================================================
 * Firestore 보안 규칙 참고 (firestore.rules에 추가)
 * ============================================================================
 * match /bookkeeping_entries/{entryId} {
 *   allow read, write: if request.auth != null; // ⚠ ADJUST: 기존 인증 규칙과 동일하게 맞추세요
 * }
 * ============================================================================
 */
