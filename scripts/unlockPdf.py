import os
import PyPDF2

# ===== ===== ===== ===== MAIN SETTINGS ===== ===== ===== ===== #

folder_path = r"C:\Users\LENOVO\Desktop\Documents\תלושי שכר"
password_file_name = "Atzmai_pass.txt"

# -------------------------------------------------------------
# TOGGLE FORMAT MODE:
# Set to "SHECODES" for YYYY_MM.pdf format (from original filename)
# Set to "REGULAR" for original text-extraction format (PayCheck_...)
FORMAT_MODE = "SHECODES" 
# -------------------------------------------------------------

# ===== ===== ===== ===== ===== ===== ===== ===== ===== ===== ===== #

dest_dir = folder_path + "/decrypted_files"

# Create destination directory if it does not exist
os.makedirs(dest_dir, exist_ok=True)


# --- Helper function to read password from TXT file ---
def get_password_from_file(folder, file_name):
    file_path = os.path.join(folder, file_name)
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Password file not found at: {file_path}")
    
    with open(file_path, "r", encoding="utf-8") as f:
        # Read the first line and remove any leading/trailing whitespaces or newlines
        return f.read().strip()


# --- SHECODES Mode: Extract date from original filename ---
def rename_shecodes_format(filename):
    name_without_ext = os.path.splitext(filename)[0]
    parts = name_without_ext.split('_')
    if len(parts) >= 3:
        year = parts[1]  # "2026"
        month = parts[2] # "05"
        return f"{year}_{month}.pdf"
    return "decrypted_" + filename


# --- REGULAR Mode: Original logic (Extract text from inside PDF) ---
def rename_regular_format(reader, filename):
    first_page = reader.pages[0]
    text = first_page.extract_text()
    new_filename = None
    
    for line in text.split('\n'):
        if "תלוש שכר לחודש" in line:
            new_filename = line.split("תלוש שכר לחודש")[0].strip() + ".pdf"
            new_filename = "PayCheck_" + new_filename.replace("/", "_")
            break
            
    if new_filename:
        return new_filename
    else:
        return "decrypted_" + filename


# --- Main function to decrypt and save PDF ---
def remove_pdf_password_and_rename(input_pdf, filename, password):
    try:
        with open(input_pdf, "rb") as input_file:
            reader = PyPDF2.PdfReader(input_file)
            
            if reader.is_encrypted:
                reader.decrypt(password)
                
                # Copy pages to writer object
                writer = PyPDF2.PdfWriter()
                for page_num in range(len(reader.pages)):
                    writer.add_page(reader.pages[page_num])
                
                # Determine new filename based on active mode
                if FORMAT_MODE == "SHECODES":
                    new_filename = rename_shecodes_format(filename)
                else:
                    new_filename = rename_regular_format(reader, filename)
                
                new_output_pdf_path = os.path.join(dest_dir, new_filename)
                
                # Save the decrypted file
                with open(new_output_pdf_path, "wb") as output_file:
                    writer.write(output_file)
                
                print(f"decrypted file: {input_pdf} (Mode: {FORMAT_MODE} -> {new_filename})")
            else:
                print(f"The file is not encrypted: {input_pdf}")
    except Exception as e:
        print(f"Error processing {input_pdf}: {e}")


# ===== ===== ===== ===== MAIN EXECUTION ===== ===== ===== ===== #

try:
    # Load password from the TXT file before running the loop
    password = get_password_from_file(folder_path, password_file_name)
    
    # Iterate through all PDF files in the folder
    for filename in os.listdir(folder_path):
        if filename.lower().endswith(".pdf"):
            input_pdf_path = os.path.join(folder_path, filename)
            remove_pdf_password_and_rename(input_pdf_path, filename, password)

except FileNotFoundError as e:
    print(e)