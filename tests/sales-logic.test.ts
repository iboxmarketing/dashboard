import assert from "node:assert/strict";
import test from "node:test";
import { classifySalesStatus, fieldDisplayValue } from "../lib/sales-logic";
import { resolvePostSalePipelines } from "../lib/pipelines";

test("Not Relevant marketing sifatsizligi sifatida ajratiladi", () => {
  assert.equal(classifySalesStatus({ stage: "Not Relevant", paymentReached: false, inPostSalePipeline: false }), "LOW_QUALITY");
});

test("Закрыто и не реализовано sales loss sifatida ajratiladi", () => {
  assert.equal(classifySalesStatus({ stage: "Закрыто и не реализовано", paymentReached: false, inPostSalePipeline: false }), "LOST");
});

test("Oplata yoki post-sale funnel sotuvni bir marta tasdiqlaydi", () => {
  assert.equal(classifySalesStatus({ stage: "Oplata poluchena", paymentReached: true, inPostSalePipeline: false }), "WON");
  assert.equal(classifySalesStatus({ stage: "Obucheniya", paymentReached: false, inPostSalePipeline: true }), "WON");
});

test("Причина провала enum qiymati nomga aylantiriladi", () => {
  assert.equal(fieldDisplayValue("7", new Map([["7", "Telefon noto‘g‘ri"]])), "Telefon noto‘g‘ri");
});

test("IBOX va SD post-sale funnel Cyrillic nom bilan topiladi", () => {
  const rows = resolvePostSalePipelines([
    { id: "1", name: "IBOX Sales" }, { id: "2", name: "SD Sales" },
    { id: "3", name: "IBOX Обучение Сопровождение" }, { id: "4", name: "SD Обучение / Сопровождение" },
    { id: "5", name: "Call Center" },
  ], [], []);
  assert.deepEqual(rows.map((row) => row.id), ["3", "4"]);
});
