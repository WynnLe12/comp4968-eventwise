import { useState } from "react";
import { Badge, Button, Card, Field, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";

const steps = ["Upload", "Review details", "Confirm"];

export function Contracts() {
  const [step, setStep] = useState(2);
  return (
    <>
      <PageHeader page="contracts" />
      <div className="stepper">
        {steps.map((label, i) => (
          <div className={step >= i + 1 ? "active" : ""} key={label}>
            <span>{step > i + 1 ? "✓" : i + 1}</span>
            <b>{label}</b>
            {i < steps.length - 1 && <i />}
          </div>
        ))}
      </div>
      {step === 1 ? (
        <div className="contract-upload">
          <Icon name="scan" size={34} />
          <h2>Upload a vendor contract</h2>
          <p>
            We’ll extract payment amounts, due dates, cancellation terms, and key contacts for you
            to review.
          </p>
          <Button onClick={() => setStep(2)} icon="upload">
            Choose contract
          </Button>
          <small>PDF or DOCX · Max 20 MB</small>
        </div>
      ) : step === 2 ? (
        <div className="contract-review">
          <Card className="contract-preview">
            <div className="doc-page">
              <small>THE WILLOW HOUSE</small>
              <h3>EVENT SERVICES AGREEMENT</h3>
              {Array.from({ length: 12 }).map((_, i) => (
                <p key={`a${i}`} style={{ width: `${70 + (i % 4) * 7}%` }} />
              ))}
              <mark>Final balance of $7,800 is due June 15, 2025</mark>
              {Array.from({ length: 5 }).map((_, i) => (
                <p key={`b${i}`} />
              ))}
            </div>
          </Card>
          <Card className="extracted">
            <div className="card-head">
              <div>
                <Badge tone="success">Extraction complete</Badge>
                <h3>Review extracted details</h3>
              </div>
            </div>
            <Field label="Vendor" defaultValue="The Willow House" />
            <div className="form-row">
              <Field label="Contract total" defaultValue="$12,800" />
              <Field label="Deposit paid" defaultValue="$5,000" />
            </div>
            <Field label="Final payment due" type="date" defaultValue="2025-06-15" />
            <Field label="Cancellation deadline" type="date" defaultValue="2025-07-20" />
            <label className="field">
              <span>Key terms</span>
              <textarea defaultValue="Final guest count due 14 days before event. Outdoor ceremony includes indoor weather backup." />
            </label>
            <div className="extraction-note">
              <Icon name="spark" size={16} />
              Please review these details against the original contract.
            </div>
            <Button onClick={() => setStep(3)}>Confirm and save</Button>
          </Card>
        </div>
      ) : (
        <Card className="success-card">
          <div>
            <Icon name="check" size={30} />
          </div>
          <h2>Contract saved</h2>
          <p>
            We added the payment date to your expenses and timeline, and stored the original file in
            Documents.
          </p>
          <Button onClick={() => setStep(1)}>Extract another contract</Button>
        </Card>
      )}
    </>
  );
}
