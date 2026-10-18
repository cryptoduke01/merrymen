use anchor_lang::prelude::*;
pub const MAX_OPS: usize = 96;
pub const DAY: i64 = 86_400;
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Debit {
    pub timestamp: i64,
    pub notional: u64,
}
#[derive(Debug, PartialEq, Eq)]
pub enum RiskError {
    InvalidLimits,
    Expired,
    ClockRegression,
    PerTrade,
    Daily,
    Operations,
    Overflow,
}
pub fn limits(
    per_trade: u64,
    daily: u64,
    max_ops: u16,
    expiry: i64,
    now: i64,
) -> std::result::Result<(), RiskError> {
    if per_trade == 0 || per_trade > daily || max_ops == 0 || max_ops as usize > MAX_OPS {
        return Err(RiskError::InvalidLimits);
    }
    if now < 0 || expiry <= now {
        return Err(RiskError::Expired);
    }
    Ok(())
}
pub fn record(
    debits: &[Debit],
    notional: u64,
    per_trade: u64,
    daily: u64,
    max_ops: u16,
    expiry: i64,
    now: i64,
) -> std::result::Result<Vec<Debit>, RiskError> {
    limits(per_trade, daily, max_ops, expiry, now)?;
    if notional == 0 || notional > per_trade {
        return Err(RiskError::PerTrade);
    }
    let cutoff = now.checked_sub(DAY).ok_or(RiskError::Overflow)?;
    if debits.len() > MAX_OPS || debits.iter().any(|d| d.timestamp > now || d.timestamp < 0) {
        return Err(RiskError::ClockRegression);
    }
    let mut kept: Vec<_> = debits
        .iter()
        .filter(|d| d.timestamp > cutoff)
        .cloned()
        .collect();
    if kept.len() >= max_ops as usize {
        return Err(RiskError::Operations);
    }
    let total = kept.iter().try_fold(notional, |sum, d| {
        sum.checked_add(d.notional).ok_or(RiskError::Overflow)
    })?;
    if total > daily {
        return Err(RiskError::Daily);
    }
    kept.push(Debit {
        timestamp: now,
        notional,
    });
    Ok(kept)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rolling_exact_boundary() {
        let ds = vec![
            Debit {
                timestamp: 100,
                notional: 40,
            },
            Debit {
                timestamp: 101,
                notional: 30,
            },
        ];
        assert_eq!(
            record(&ds, 70, 100, 100, 4, 100000, 86500).unwrap().len(),
            2
        );
        assert_eq!(
            record(&ds, 71, 100, 100, 4, 100000, 86500),
            Err(RiskError::Daily)
        );
    }
    #[test]
    fn no_clock_rollback() {
        assert_eq!(
            record(
                &[Debit {
                    timestamp: 101,
                    notional: 1
                }],
                1,
                100,
                100,
                4,
                1000,
                100
            ),
            Err(RiskError::ClockRegression)
        );
    }
    #[test]
    fn ops_and_expiry() {
        assert_eq!(
            record(
                &[Debit {
                    timestamp: 1,
                    notional: 1
                }],
                1,
                5,
                100,
                1,
                1000,
                2
            ),
            Err(RiskError::Operations)
        );
        assert_eq!(record(&[], 1, 5, 100, 1, 2, 2), Err(RiskError::Expired));
    }
    #[test]
    fn limits_and_overflow() {
        assert_eq!(record(&[], 6, 5, 100, 1, 1000, 2), Err(RiskError::PerTrade));
        assert_eq!(limits(10, 5, 1, 1000, 2), Err(RiskError::InvalidLimits));
        assert_eq!(
            record(
                &[Debit {
                    timestamp: 1,
                    notional: u64::MAX
                }],
                1,
                5,
                u64::MAX,
                2,
                1000,
                2
            ),
            Err(RiskError::Overflow)
        );
    }
    #[test]
    fn replacement_never_erases_history() {
        let old = record(&[], 60, 60, 100, 10, 1000, 10).unwrap();
        assert_eq!(
            record(&old, 50, 60, 100, 10, 2000, 11),
            Err(RiskError::Daily)
        );
    }
}
