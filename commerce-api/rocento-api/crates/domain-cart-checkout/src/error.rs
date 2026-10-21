//! Typed checkout failures carried through the existing shared service result.
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StaleProposal {
    CartRevisionChanged,
    ProposalUnavailable,
    QuoteFactsChanged,
}

impl StaleProposal {
    pub fn from_error(error: &infra_auth::Error) -> Option<&Self> {
        match error {
            infra_auth::Error::Business(error) => error.downcast_ref(),
            _ => None,
        }
    }
}

impl fmt::Display for StaleProposal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::CartRevisionChanged => {
                "Your cart changed. Refresh the proposal and review it again."
            }
            Self::ProposalUnavailable => {
                "Proposal expired, changed, cancelled or has unresolved constraints. Review a fresh quote."
            }
            Self::QuoteFactsChanged => {
                "Prices, availability or product facts changed. Requote and approve the updated proposal."
            }
        })
    }
}

impl std::error::Error for StaleProposal {}

impl From<StaleProposal> for infra_auth::Error {
    fn from(error: StaleProposal) -> Self {
        Self::Business(Box::new(error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_result_preserves_business_failure_identity() {
        for cause in [
            StaleProposal::CartRevisionChanged,
            StaleProposal::ProposalUnavailable,
            StaleProposal::QuoteFactsChanged,
        ] {
            let error: infra_auth::Error = cause.into();
            assert_eq!(StaleProposal::from_error(&error), Some(&cause));
        }
    }

    #[test]
    fn matching_message_does_not_make_an_untyped_error_stale() {
        let message = StaleProposal::CartRevisionChanged.to_string();
        assert!(StaleProposal::from_error(&infra_auth::Error::Invalid(message)).is_none());
        assert!(
            StaleProposal::from_error(&infra_auth::Error::Business(Box::new(
                std::io::Error::other("unrelated failure"),
            )))
            .is_none()
        );
    }
}
