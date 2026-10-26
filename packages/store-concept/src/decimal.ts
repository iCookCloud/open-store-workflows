/**
 * 将输入 Number 的标准十进制表示视为比例的精确值，再统一小数位做整数加减。
 * 不设 epsilon：0.1 + 0.7 + 0.2 精确为 1，而真正小于 1 的比例仍保留正贡献率。
 * 最后才转回 Number，供金额乘除与最终币种舍入使用。
 */
export function decimalSum(values: readonly number[]): number {
  const parts = values.map((value) => {
    if (!Number.isFinite(value)) throw new Error('Decimal arithmetic requires finite values');
    const [mantissa, exponentText] = value.toString().split('e');
    const [integer, fraction = ''] = mantissa!.split('.');
    const exponent = exponentText === undefined ? 0 : Number(exponentText);
    return { units: BigInt(`${integer}${fraction}`), scale: fraction.length - exponent };
  });
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  const total = parts.reduce(
    (sum, part) => sum + part.units * 10n ** BigInt(scale - part.scale),
    0n,
  );
  return Number(`${total}e-${scale}`);
}
