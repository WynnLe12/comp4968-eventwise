import { useState } from "react";
import { Badge, Button, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";

const qrFilled = new Set([0, 1, 2, 5, 7, 10, 12, 14, 16, 18, 20, 21, 22, 23, 24]);

export function Photos() {
  const [approved, setApproved] = useState<number[]>([0, 2, 4]);
  const approve = (i: number) => {
    if (!approved.includes(i)) setApproved([...approved, i]);
  };

  return (
    <>
      <PageHeader page="photos" action={<Button icon="download">Download all</Button>} />
      <div className="qr-banner">
        <div className="qr-code" aria-hidden="true">
          {Array.from({ length: 25 }).map((_, i) => (
            <i key={i} className={qrFilled.has(i) ? "filled" : ""} />
          ))}
        </div>
        <div>
          <div className="eyebrow">GUEST PHOTO GALLERY</div>
          <h2>Let guests capture every angle</h2>
          <p>
            Share the QR code at your event. Photos arrive here for your approval before appearing
            in the gallery.
          </p>
          <Button variant="secondary" icon="link">
            Copy upload link
          </Button>
        </div>
        <div className="qr-stats">
          <b>38</b>
          <span>photos uploaded</span>
          <b>24</b>
          <span>approved</span>
        </div>
      </div>
      <div className="gallery-head">
        <div>
          <h3>Pending approval</h3>
          <p>14 guest uploads need your review</p>
        </div>
        <Button variant="ghost">Select all</Button>
      </div>
      <div className="photo-grid">
        {Array.from({ length: 8 }).map((_, i) => (
          <div className={`photo-placeholder photo-${i % 4}`} key={i}>
            <div className="photo-art">
              <span />
              <i />
            </div>
            <div className="photo-overlay">
              <button onClick={() => approve(i)}>
                {approved.includes(i) ? "Approved" : "Approve"}
              </button>
              <button aria-label="Delete photo">
                <Icon name="trash" size={16} />
              </button>
            </div>
            {approved.includes(i) && <Badge tone="success">Approved</Badge>}
          </div>
        ))}
      </div>
    </>
  );
}
