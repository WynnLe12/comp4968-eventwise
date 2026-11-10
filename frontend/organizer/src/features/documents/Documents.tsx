import { Button, Card, Icon } from "../../components/ui";
import { PageHeader } from "../../components/page";

const files = [
  { name: "Venue Contract.pdf", kind: "Contract", size: "2.4 MB", uploaded: "May 12", tone: "purple" },
  { name: "Photography Proposal.pdf", kind: "Quote", size: "1.1 MB", uploaded: "May 10", tone: "coral" },
  { name: "Catering Menu v3.pdf", kind: "Menu", size: "820 KB", uploaded: "May 08", tone: "gold" },
  { name: "Floral Moodboard.jpg", kind: "Inspiration", size: "3.7 MB", uploaded: "Apr 29", tone: "pink" },
  { name: "Guest List.csv", kind: "Guest list", size: "42 KB", uploaded: "Apr 25", tone: "blue" },
];

export function Documents() {
  return (
    <>
      <PageHeader page="documents" action={<Button icon="upload">Upload document</Button>} />
      <div className="upload-zone">
        <div>
          <Icon name="upload" />
        </div>
        <b>Drop files here to upload</b>
        <span>PDF, DOCX, JPG, PNG, or CSV up to 20 MB</span>
        <Button variant="secondary">Choose files</Button>
      </div>
      <Card>
        <div className="card-head">
          <div>
            <h3>All documents</h3>
            <p>5 files · 8.1 MB total</p>
          </div>
          <div className="search-input">
            <Icon name="search" />
            <input placeholder="Search files..." aria-label="Search files" />
          </div>
        </div>
        <div className="file-list">
          {files.map((f) => (
            <div className="file-row" key={f.name}>
              <div className={`file-icon ${f.tone}`}>
                <Icon name="file" />
              </div>
              <div>
                <b>{f.name}</b>
                <span>
                  {f.kind} · {f.size}
                </span>
              </div>
              <span>Uploaded {f.uploaded}</span>
              <button className="icon-btn" title="Preview" aria-label="Preview">
                <Icon name="eye" />
              </button>
              <button className="icon-btn" title="Download" aria-label="Download">
                <Icon name="download" />
              </button>
              <button className="icon-btn" aria-label="More options">
                <Icon name="more" />
              </button>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
